/** A domain validation failure, expressed without throwing for untrusted external input. */
export interface DomainViolation {
  readonly code: string;
  readonly message: string;
}

/** Result of a domain factory that must validate input instead of throwing. */
export type DomainResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: DomainViolation };

export function ok<T>(value: T): DomainResult<T> {
  return { ok: true, value };
}

export function err(code: string, message: string): DomainResult<never> {
  return { ok: false, error: { code, message } };
}
