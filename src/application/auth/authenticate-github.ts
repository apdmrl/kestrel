import type { CredentialStore } from "../../ports/credential-store.js";
import type { DeviceFlowAuthorization, GitHubGateway } from "../../ports/github-gateway.js";
import { createKestrelError } from "../errors/kestrel-error.js";
import { isKestrelError } from "../errors/kestrel-error.js";

export interface AuthenticateGitHubDeps {
  readonly credentialStore: CredentialStore;
  readonly gateway: GitHubGateway;
}

/** A signal that is never aborted; supplied to the credential port when the
 * caller did not compose a cancellation context of its own. */
const NEVER_ABORTED: AbortSignal = new AbortController().signal;

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
 *
 * The same effective `AbortSignal` (caller's signal or a never-aborted
 * fallback) reaches every credential effect — `get`, `delete` (on mismatch and
 * expiry), and `store` — so a hung Git credential helper exits when the parent
 * aborts.
 */
export async function authenticateGitHub(
  deps: AuthenticateGitHubDeps,
  input: AuthenticateGitHubInput,
): Promise<AuthenticateGitHubResult> {
  const signal = input.signal ?? NEVER_ABORTED;
  const cached = await deps.credentialStore.get("github", input.account, signal);
  if (cached !== undefined) {
    try {
      const viewer = await deps.gateway.getViewer(cached.token, signal);
      if (viewer.login === cached.account) {
        return { account: cached.account, token: cached.token };
      }
      await deps.credentialStore.delete("github", cached.account, signal);
    } catch (error) {
      if (isKestrelError(error) && error.code === "DM_GITHUB_AUTH_EXPIRED") {
        await deps.credentialStore.delete("github", cached.account, signal);
      } else {
        throw error;
      }
    }
  }

  if (input.interactive === false) {
    throw deviceFlowRequiresInteractiveError();
  }

  const authorization = await deps.gateway.beginDeviceFlow(signal);
  if (input.onAuthorization !== undefined) {
    await input.onAuthorization(authorization);
  }
  const token = await deps.gateway.pollForToken(authorization.deviceCode, signal);
  await deps.credentialStore.store(
    {
      service: "github",
      account: token.account,
      token: token.token,
    },
    signal,
  );
  return { account: token.account, token: token.token };
}
