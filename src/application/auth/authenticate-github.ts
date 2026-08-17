import type { CredentialStore } from "../../ports/credential-store.js";
import type { DeviceFlowAuthorization, GitHubGateway } from "../../ports/github-gateway.js";
import { isKestrelError } from "../errors/kestrel-error.js";

export interface AuthenticateGitHubDeps {
  readonly credentialStore: CredentialStore;
  readonly gateway: GitHubGateway;
}

export interface AuthenticateGitHubInput {
  readonly account: string;
  readonly signal?: AbortSignal;
  readonly onAuthorization?: (authorization: DeviceFlowAuthorization) => Promise<void> | void;
}

export interface AuthenticateGitHubResult {
  readonly account: string;
  readonly token: string;
}

/**
 * Authenticate with GitHub: reuse a cached token, otherwise run the device flow.
 * Expired tokens are removed before re-authenticating.
 */
export async function authenticateGitHub(
  deps: AuthenticateGitHubDeps,
  input: AuthenticateGitHubInput,
): Promise<AuthenticateGitHubResult> {
  const cached = await deps.credentialStore.get("github", input.account);
  if (cached !== undefined) {
    try {
      const viewer = await deps.gateway.getViewer(cached.token);
      if (viewer.login === input.account) {
        return { account: input.account, token: cached.token };
      }
      await deps.credentialStore.delete("github", input.account);
    } catch (error) {
      if (isKestrelError(error) && error.code === "DM_GITHUB_AUTH_EXPIRED") {
        await deps.credentialStore.delete("github", input.account);
      } else {
        throw error;
      }
    }
  }

  const authorization = await deps.gateway.beginDeviceFlow();
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
