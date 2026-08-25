import type { CredentialStore } from "../../ports/credential-store.js";
import { createKestrelError } from "../errors/kestrel-error.js";

export type LogoutDetail = "LOGGED_OUT";

export interface LogoutResult {
  readonly connected: false;
  readonly login: null;
  readonly detail: LogoutDetail;
}

export interface LogoutGitHubDeps {
  readonly credentialStore: CredentialStore;
}

export interface LogoutGitHubInput {
  readonly confirmation: string | undefined;
}

/**
 * The token a caller must supply to confirm a logout.
 *
 * It is the host whose credential will be cleared, so the token names its own
 * consequence and is safe to print in the error that demands it.
 */
export function logoutConfirmationToken(): string {
  return "github.com";
}

/** Verify a logout confirmation token, requiring an exact match. */
export function confirmLogout(token: string | undefined): boolean {
  return token === logoutConfirmationToken();
}

function confirmationRequiredError() {
  return createKestrelError({
    code: "DM_ILLEGAL_TRANSITION",
    category: "INVALID_INPUT",
    userMessage: "Logging out clears the shared github.com credential, which git and gh also use",
    suggestedActions: [
      "Re-run with --confirm github.com to clear it",
      "Leave it in place if git or gh still need to authenticate",
    ],
    retryability: "NO_RETRY",
    recoveryStrategy: "USER_ACTION",
    severity: "WARNING",
  });
}

/**
 * Clear the stored GitHub credential.
 *
 * The credential store is host-scoped, so this removes the `github.com` entry
 * that `git push` and `gh` also read. That blast radius cannot be narrowed
 * without changing the credential key, so the operation is gated behind an
 * explicit confirmation token instead, and refuses without mutating anything.
 *
 * The stored account is read first so the reject payload carries the username
 * the helper recorded. Logging out with nothing stored is not an error.
 */
export async function logoutGitHub(
  deps: LogoutGitHubDeps,
  input: LogoutGitHubInput,
): Promise<LogoutResult> {
  if (!confirmLogout(input.confirmation)) {
    throw confirmationRequiredError();
  }
  const existing = await deps.credentialStore.get("github", logoutConfirmationToken());
  if (existing !== undefined) {
    await deps.credentialStore.delete("github", existing.account);
  }
  return { connected: false, login: null, detail: "LOGGED_OUT" };
}
