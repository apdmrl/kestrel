export interface Credential {
  readonly service: string;
  readonly account: string;
  readonly token: string;
}

/** Stores/retrieves/deletes a credential token by service and account.
 *
 * Every method requires a cancellation `signal` so a hung credential helper or
 * network call never outlives the caller's command. Pass the per-invocation
 * `CommandContext.signal` (or a fresh `AbortController().signal` when the
 * caller has no broader cancellation to compose with). Implementations must
 * forward the signal into any subprocess or network I/O.
 */
export interface CredentialStore {
  get(
    service: string,
    account: string,
    signal: AbortSignal,
  ): Promise<Credential | undefined>;
  store(credential: Credential, signal: AbortSignal): Promise<void>;
  delete(service: string, account: string, signal: AbortSignal): Promise<void>;
}