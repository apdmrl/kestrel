import type { DomainResult } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";

/** Validate the top-level schemaVersion discriminator before deeper parsing. */
export function checkSchemaVersion(data: unknown): DomainResult<1> {
  if (typeof data !== "object" || data === null) {
    return err("DM_STATE_CORRUPTED", "state is not an object");
  }
  const version = (data as Record<string, unknown>).schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return err("DM_STATE_CORRUPTED", "missing or invalid schemaVersion");
  }
  if (version > 1) {
    return err(
      "DM_STATE_VERSION_UNSUPPORTED",
      `schema version ${version} is newer than supported version 1`,
    );
  }
  return ok(1 as const);
}
