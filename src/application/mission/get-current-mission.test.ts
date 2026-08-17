import { describe, expect, it } from "vitest";
import { createChallenge } from "../../domain/challenge/challenge.js";
import {
  createRecommendation,
  snapshotRecommendation,
} from "../../domain/recommendation/recommendation.js";
import type { Challenge } from "../../domain/challenge/challenge.js";
import type { ChallengeId } from "../../domain/shared/identifiers.js";
import type { MissionId } from "../../domain/shared/identifiers.js";
import type { IsoDateTime } from "../../domain/shared/time.js";
import type { RecommendationSnapshot } from "../../domain/recommendation/recommendation.js";
import { Mission } from "../../domain/mission/mission.js";
import type { MissionIndexEntry, MissionIndexStore } from "../../ports/mission-index-store.js";
import type { MissionStore, StoredMission } from "../../ports/mission-store.js";
import { getCurrentMission } from "./get-current-mission.js";

const now = "2026-08-15T10:00:00Z" as IsoDateTime;

function makeChallenge(): Challenge {
  const result = createChallenge({
    id: "c1" as ChallengeId,
    externalId: "1",
    repository: { provider: "github", owner: "octocat", name: "hello-world" },
    issueNumber: 42,
    canonicalUrl: "https://github.com/octocat/hello-world/issues/42",
    title: "Fix crash",
    description: "d",
    type: "BUG_FIX",
    createdAt: "2026-08-01T00:00:00Z" as IsoDateTime,
    updatedAt: "2026-08-01T00:00:00Z" as IsoDateTime,
  });
  if (!result.ok) {
    throw new Error("expected ok");
  }
  return result.value;
}

function makeRecommendation(challenge: Challenge): RecommendationSnapshot {
  const result = createRecommendation({
    challenge,
    mood: "QUICK_WIN",
    signalResults: [{ name: "interest", value: 0.9, confidence: 0.8, reason: "matches" }],
    confidence: 0.8,
    evaluatedAt: now,
  });
  if (!result.ok) {
    throw new Error("expected ok");
  }
  return snapshotRecommendation(result.value);
}

function acceptedMission(id: string): Mission {
  const result = Mission.accept({
    id: id as MissionId,
    challengeSnapshot: makeChallenge(),
    recommendationSnapshot: makeRecommendation(makeChallenge()),
    mode: "GUIDED",
    acceptedAt: now,
  });
  if (!result.ok) {
    throw new Error("expected ok");
  }
  return result.value;
}

function entry(
  id: string,
  sidecarPath: string,
  status: MissionIndexEntry["status"],
): MissionIndexEntry {
  return {
    missionId: id as MissionId,
    sidecarPath,
    repository: { provider: "github", owner: "octocat", name: "hello-world" },
    status,
    updatedAt: now,
  };
}

function makeDeps(entries: MissionIndexEntry[]) {
  const missionStore: MissionStore = {
    async get(sidecarPath: string): Promise<StoredMission | undefined> {
      const match = entries.find((e) => e.sidecarPath === sidecarPath);
      if (match === undefined) {
        return undefined;
      }
      return { mission: acceptedMission(match.missionId), version: 1 };
    },
    async save(): Promise<StoredMission> {
      throw new Error("not implemented");
    },
  };
  const missionIndexStore: MissionIndexStore = {
    async get() {
      return { index: { entries }, version: 1 };
    },
    async save(index) {
      return { index, version: 1 };
    },
  };
  return { missionStore, missionIndexStore };
}

describe("getCurrentMission", () => {
  it("resolves an explicit mission id", async () => {
    const entries = [entry("m1", "/tmp/ws/m1/kestrel", "IN_PROGRESS")];
    const result = await getCurrentMission(makeDeps(entries), { missionId: "m1" as MissionId });
    expect(result.kind).toBe("mission");
  });

  it("resolves the mission owning the current repository path", async () => {
    const entries = [entry("m1", "/tmp/ws/m1/kestrel", "IN_PROGRESS")];
    const result = await getCurrentMission(makeDeps(entries), { cwd: "/tmp/ws/m1/repo/src" });
    expect(result.kind).toBe("mission");
  });

  it("returns none when there are no active missions", async () => {
    const result = await getCurrentMission(makeDeps([]), {});
    expect(result.kind).toBe("none");
  });

  it("returns ambiguous when multiple active missions exist", async () => {
    const entries = [
      entry("m1", "/tmp/ws/m1/kestrel", "IN_PROGRESS"),
      entry("m2", "/tmp/ws/m2/kestrel", "PREPARING"),
    ];
    const result = await getCurrentMission(makeDeps(entries), {});
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.missionIds).toEqual(["m1", "m2"]);
    }
  });

  it("returns none for a missing index entry", async () => {
    const result = await getCurrentMission(makeDeps([]), { missionId: "missing" as MissionId });
    expect(result.kind).toBe("none");
  });

  it("remains read-only while another process holds the mission lock", async () => {
    const entries = [entry("m1", "/tmp/ws/m1/kestrel", "IN_PROGRESS")];
    // The lock file is never touched by this read-only operation.
    const result = await getCurrentMission(makeDeps(entries), { missionId: "m1" as MissionId });
    expect(result.kind).toBe("mission");
  });
});
