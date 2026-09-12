import type { CredentialStore } from "../../ports/credential-store.js";
import type { GitHubGateway } from "../../ports/github-gateway.js";
import { createKestrelError } from "../errors/kestrel-error.js";

export interface ValidatedGitHubCredential {
  readonly token: string;
  readonly login: string;
}

export interface RequireValidatedGitHubCredentialDeps {
  readonly credentialStore: CredentialStore;
  readonly gateway: GitHubGateway;
}

export interface RequireValidatedGitHubCredentialInput {
  readonly account: string;
  readonly signal?: AbortSignal;
}

/** A signal that is never aborted; supplied to the credential port when the
 * caller did not compose a cancellation context of its own. */
const NEVER_ABORTED: AbortSignal = new AbortController().signal;

/**
 * Read the cached credential and live-validate it against the GitHub viewer
 * endpoint. This guard NEVER starts the device flow; implicit login would hide
 * a future operation to a freshly created OAuth identity. Explicit
 * `auth login` (or `/auth login` in the shell) is the only path that may
 * begin the device flow. Failing closed here means callers receive a
 * `DM_GITHUB_AUTH_REQUIRED` classified error and can route the user to the
 * dedicated login surface.
 */
export async function requireValidatedGitHubCredential(
  deps: RequireValidatedGitHubCredentialDeps,
  input: RequireValidatedGitHubCredentialInput,
): Promise<ValidatedGitHubCredential> {
  const credential = await deps.credentialStore.get(
    "github",
    input.account,
    input.signal ?? NEVER_ABORTED,
  );
  if (credential === undefined) {
    throw githubAuthRequiredError();
  }
  const viewer = await deps.gateway.getViewer(credential.token, input.signal);
  return { token: credential.token, login: viewer.login };
}

function githubAuthRequiredError() {
  return createKestrelError({
    code: "DM_GITHUB_AUTH_REQUIRED",
    category: "USER_ACTION_REQUIRED",
    userMessage: "GitHub authentication is required to continue",
    suggestedActions: ["Run 'kestrel auth login' to authenticate, then retry"],
    retryability: "NO_RETRY",
    recoveryStrategy: "REAUTHENTICATE",
    severity: "ERROR",
  });
}
