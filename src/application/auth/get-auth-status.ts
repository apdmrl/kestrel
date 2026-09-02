import type { CredentialStore } from "../../ports/credential-store.js";
import type { GitHubGateway } from "../../ports/github-gateway.js";
import { isKestrelError } from "../errors/kestrel-error.js";

export type AuthStatusDetail = "CONNECTED" | "NOT_CONNECTED" | "EXPIRED";

export interface AuthStatus {
  readonly connected: boolean;
  /** The login GitHub reports for the stored token, or null when unknown. */
  readonly login: string | null;
  readonly detail: AuthStatusDetail;
}

/** A signal that is never aborted; supplied to the credential port when the
 * caller did not compose a cancellation context of its own. */
const NEVER_ABORTED: AbortSignal = new AbortController().signal;

export interface GetAuthStatusDeps {
  readonly credentialStore: CredentialStore;
  readonly gateway: GitHubGateway;
}

export interface GetAuthStatusInput {
  readonly account: string;
  readonly signal?: AbortSignal;
}

const NOT_CONNECTED: AuthStatus = { connected: false, login: null, detail: "NOT_CONNECTED" };
const EXPIRED: AuthStatus = { connected: false, login: null, detail: "EXPIRED" };

/**
 * Report whether a stored GitHub credential is still usable.
 *
 * The stored token is validated against GitHub so a revoked credential is not
 * reported as connected, and the login is taken from the live viewer rather
 * than the stored account key, which is host-scoped and can disagree.
 *
 * Unlike `authenticateGitHub`, an expired credential is reported and left in
 * place. Reading status must not mutate durable state; the deletion still
 * happens on the next login. Errors other than expiry propagate so a network
 * failure is never misreported as "not connected".
 *
 * The token is never included in the result.
 */
export async function getAuthStatus(
  deps: GetAuthStatusDeps,
  input: GetAuthStatusInput,
): Promise<AuthStatus> {
  const cached = await deps.credentialStore.get(
    "github",
    input.account,
    input.signal ?? NEVER_ABORTED,
  );
  if (cached === undefined) {
    return NOT_CONNECTED;
  }
  try {
    const viewer = await deps.gateway.getViewer(cached.token, input.signal);
    return { connected: true, login: viewer.login, detail: "CONNECTED" };
  } catch (error) {
    if (isKestrelError(error) && error.code === "DM_GITHUB_AUTH_EXPIRED") {
      return EXPIRED;
    }
    throw error;
  }
}
