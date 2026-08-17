import type { DomainResult } from "../shared/result.js";
import { err, ok } from "../shared/result.js";
import type { Evidence } from "./evidence.js";

/** An append-only, replay-safe collection of engineering evidence. */
export interface EvidenceCollection {
  readonly items: readonly Evidence[];
}

export function createEvidenceCollection(items?: readonly Evidence[]): EvidenceCollection {
  return { items: items ? [...items] : [] };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) {
      return false;
    }
    return aKeys.every((key) =>
      deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    );
  }
  return false;
}

/**
 * Append evidence by ID. Identical replay is idempotent; a differing item with
 * an already-known ID is rejected rather than silently overwriting history.
 */
export function addEvidence(
  collection: EvidenceCollection,
  item: Evidence,
): DomainResult<EvidenceCollection> {
  const existing = collection.items.find((entry) => entry.id === item.id);
  if (existing !== undefined) {
    if (deepEqual(existing, item)) {
      return ok(collection);
    }
    return err(
      "DM_EVIDENCE_CONFLICT",
      `evidence id "${String(item.id)}" already exists with different content`,
    );
  }
  return ok({ items: [...collection.items, item] });
}
