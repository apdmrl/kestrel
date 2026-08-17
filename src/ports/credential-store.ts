export interface Credential {
  readonly service: string;
  readonly account: string;
  readonly token: string;
}

/** Stores/retrieves/deletes a credential token by service and account. */
export interface CredentialStore {
  get(service: string, account: string): Promise<Credential | undefined>;
  store(credential: Credential): Promise<void>;
  delete(service: string, account: string): Promise<void>;
}
