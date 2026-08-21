import type { CredentialStore } from "../../ports/credential-store.js";
import type { DeviceFlowAuthorization, GitHubGateway } from "../../ports/github-gateway.js";
import { createKestrelError } from "../errors/kestrel-error.js";
import { isKestrelError } from "../errors/kestrel-error.js";

export interface AuthenticateGitHubDeps {
  readonly credentialStore: CredentialStore;
  readonly gateway: GitHubGateway;
}

export interface AuthenticateGitHubInput {
  readonly account: string;
  readonly signal?: AbortSignal;
  /** Whether device flow may be started. Defaults to true (interactive). */
  readonly interactive?: boolean;
  readonly onAuthorization?: (authorization: DeviceFlowAuthorization) => Promise<void> | void;
}

export interface AuthenticateGitHubResult {
  readonly account: string;
  readonly token: string;
}

function deviceFlowRequiresInteractiveError() {
  return createKestrelError({
    code: "DM_GITHUB_AUTH_REQUIRED",
    category: "USER_ACTION_REQUIRED",
    userMessage: "GitHub device authentication requires an interactive session",
    suggestedActions: [
      "Run the command in an interactive terminal, or configure a Git credential helper",
    ],
    retryability: "NO_RETRY",
    recoveryStrategy: "USER_ACTION",
    severity: "ERROR",
  });
}

/**
 * Authenticate with GitHub: reuse a valid cached token, otherwise run the device
 * flow. A cached token is always validated against the stored account before it
 * is reused; expired or revoked tokens are removed before re-authenticating.
 */
export async function authenticateGitHub(
  deps: AuthenticateGitHubDeps,
  input: AuthenticateGitHubInput,
): Promise<AuthenticateGitHubResult> {
  const cached = await deps.credentialStore.get("github", input.account);
  if (cached !== undefined) {
    try {
      const viewer = await deps.gateway.getViewer(cached.token, input.signal);
      if (viewer.login === cached.account) {
        return { account: cached.account, token: cached.token };
      }
      await deps.credentialStore.delete("github", cached.account);
    } catch (error) {
      if (isKestrelError(error) && error.code === "DM_GITHUB_AUTH_EXPIRED") {
        await deps.credentialStore.delete("github", cached.account);
      } else {
        throw error;
      }
    }
  }

  if (input.interactive === false) {
    throw deviceFlowRequiresInteractiveError();
  }

  const authorization = await deps.gateway.beginDeviceFlow(input.signal);
  if (input.onAuthorization !== undefined) {
    await input.onAuthorization(authorization);
  }
  const token = await deps.gateway.pollForToken(authorization.deviceCode, input.signal);
  await deps.credentialStore.store({
    service: "github",
    account: token.account,
    token: token.token,
  });
  return { account: token.account, token: token.token };
}
