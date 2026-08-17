import { describe, expect, it } from "vitest";
import type { MissionId } from "../shared/identifiers.js";
import type { IsoDateTime } from "../shared/time.js";
import { addEvidence, createEvidenceCollection } from "./evidence-collection.js";
import { createCommitEvidence, type Evidence, type EvidenceId } from "./evidence.js";

const missionId = "m1" as MissionId;
const observedAt = "2026-08-15T00:00:00Z" as IsoDateTime;

function commitEvidence(id: string, message: string): Evidence {
  const result = createCommitEvidence({
    id: id as EvidenceId,
    missionId,
    observedAt,
    sha: "abc123",
    message,
    author: "dev",
    committedAt: observedAt,
  });
  if (!result.ok) {
    throw new Error("expected ok");
  }
  return result.value;
}

describe("EvidenceCollection", () => {
  it("appends a new evidence item immutably", () => {
    const original = createEvidenceCollection();
    const item = commitEvidence("e1", "first");
    const result = addEvidence(original, item);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items).toHaveLength(1);
      expect(result.value.items[0]).toEqual(item);
    }
    expect(original.items).toHaveLength(0);
  });

  it("is idempotent when replaying an identical evidence item", () => {
    const first = commitEvidence("e1", "first");
    const once = addEvidence(createEvidenceCollection(), first);
    if (!once.ok) {
      throw new Error("expected ok");
    }
    const replay = addEvidence(once.value, commitEvidence("e1", "first"));
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.value).toBe(once.value);
      expect(replay.value.items).toHaveLength(1);
    }
  });

  it("rejects a conflicting duplicate evidence id", () => {
    const first = commitEvidence("e1", "first");
    const once = addEvidence(createEvidenceCollection(), first);
    if (!once.ok) {
      throw new Error("expected ok");
    }
    const conflicting = addEvidence(once.value, commitEvidence("e1", "different"));
    expect(conflicting.ok).toBe(false);
    if (!conflicting.ok) {
      expect(conflicting.error.code).toContain("CONFLICT");
    }
  });
});
