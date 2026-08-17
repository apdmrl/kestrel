import type { DomainResult } from "../shared/result.js";
import { err, ok } from "../shared/result.js";

export type RepositoryProvider = "github";

export interface RepositoryIdentity {
  readonly provider: RepositoryProvider;
  readonly owner: string;
  readonly name: string;
}

function normalizeComponent(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function createRepositoryIdentity(input: {
  readonly provider?: unknown;
  readonly owner: unknown;
  readonly name: unknown;
}): DomainResult<RepositoryIdentity> {
  const provider = input.provider ?? "github";
  if (provider !== "github") {
    return err("DM_UNSUPPORTED_PROVIDER", `Unsupported repository provider: ${String(provider)}`);
  }
  const owner = normalizeComponent(input.owner);
  const name = normalizeComponent(input.name);
  if (owner === null || name === null) {
    return err("DM_INVALID_REPOSITORY", "Repository owner and name must be non-empty strings");
  }
  return ok({
    provider: "github",
    owner: owner.toLowerCase(),
    name: name.toLowerCase(),
  });
}
