import type { Brand } from "./brand.js";
import type { DomainResult } from "./result.js";
import { err, ok } from "./result.js";

/** An immutable, validated ISO 8601 (RFC 3339) UTC or offset date-time. */
export type IsoDateTime = Brand<string, "IsoDateTime">;

const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

export function parseIsoDateTime(input: string): DomainResult<IsoDateTime> {
  const value = input.trim();
  if (value.length === 0) {
    return err("DM_INVALID_TIMESTAMP", "Timestamp must not be empty");
  }
  if (!ISO_PATTERN.test(value)) {
    return err("DM_INVALID_TIMESTAMP", `Malformed ISO 8601 timestamp: ${value}`);
  }
  if (Number.isNaN(Date.parse(value))) {
    return err("DM_INVALID_TIMESTAMP", `Invalid calendar date in timestamp: ${value}`);
  }
  return ok(value as IsoDateTime);
}

/** Trusted derivation from a Date for clock adapters (always produces a valid value). */
export function isoDateTimeFromDate(date: Date): IsoDateTime {
  return date.toISOString() as IsoDateTime;
}
