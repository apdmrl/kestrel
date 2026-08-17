import { describe, expect, it } from "vitest";
import { createChallenge } from "../challenge/challenge.js";
import { createRecommendation, snapshotRecommendation } from "../recommendation/recommendation.js";
import type { Challenge } from "../challenge/challenge.js";
import type { ChallengeId } from "../shared/identifiers.js";
import type { MissionId } from "../shared/identifiers.js";
import type { IsoDateTime } from "../shared/time.js";
import type { RecommendationSnapshot } from "../recommendation/recommendation.js";
import { Mission } from "./mission.js";
import type { WorkspaceInfo } from "./mission.js";
import { PREPARATION_CHECKPOINTS } from "./preparation-checkpoint.js";

const acceptedAt = "2026-08-15T10:00:00Z" as IsoDateTime;

const workspace: WorkspaceInfo = {
  root: "/tmp/ws",
  missionDirectory: "/tmp/ws/m1",
  repositoryPath: "/tmp/ws/m1/repo",
  sidecarPath: "/tmp/ws/m1/kestrel",
};

function makeChallenge(): Challenge {
  const result = createChallenge({
    id: "c1" as ChallengeId,
    externalId: "1",
    repository: { provider: "github", owner: "o", name: "n" },
    issueNumber: 1,
    canonicalUrl: "https://github.com/o/n/issues/1",
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
    evaluatedAt: acceptedAt,
  });
  if (!result.ok) {
    throw new Error("expected ok");
  }
  return snapshotRecommendation(result.value);
}

function preparingMission(): Mission {
  const accepted = Mission.accept({
    id: "m1" as MissionId,
    challengeSnapshot: makeChallenge(),
    recommendationSnapshot: makeRecommendation(makeChallenge()),
    mode: "GUIDED",
    acceptedAt,
  });
  const preparing = accepted.ok ? accepted.value.startPreparation() : null;
  if (!preparing?.ok) {
    throw new Error("expected ok");
  }
  return preparing.value;
}

describe("preparation checkpoints", () => {
  it("advances through checkpoints in order", () => {
    let mission = preparingMission();
    for (const checkpoint of PREPARATION_CHECKPOINTS) {
      const result = mission.recordPreparationCheckpoint(checkpoint, {});
      expect(result.ok).toBe(true);
      if (result.ok) {
        mission = result.value;
      }
    }
    expect(mission.preparationCheckpoints.map((c) => c.checkpoint)).toEqual(
      PREPARATION_CHECKPOINTS,
    );
  });

  it("replays the same checkpoint idempotently", () => {
    const first = preparingMission().recordPreparationCheckpoint("WORKSPACE_CREATED", {
      path: "/tmp/ws/m1",
    });
    if (!first.ok) {
      throw new Error("expected ok");
    }
    const replay = first.value.recordPreparationCheckpoint("WORKSPACE_CREATED", {
      path: "/tmp/ws/m1",
    });
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.value.preparationCheckpoints).toHaveLength(1);
    }
  });

  it("rejects conflicting checkpoint data", () => {
    const first = preparingMission().recordPreparationCheckpoint("WORKSPACE_CREATED", {
      path: "a",
    });
    if (!first.ok) {
      throw new Error("expected ok");
    }
    const conflict = first.value.recordPreparationCheckpoint("WORKSPACE_CREATED", { path: "b" });
    expect(conflict.ok).toBe(false);
  });

  it("rejects skipping a checkpoint", () => {
    const result = preparingMission().recordPreparationCheckpoint("BRANCH_CREATED", {});
    expect(result.ok).toBe(false);
  });

  it("cannot mark IN_PROGRESS before all checkpoints", () => {
    const mission = preparingMission();
    const result = mission.completePreparation({ workspace, baseCommit: "x", branch: "b" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("DM_PREPARATION_INCOMPLETE");
    }
  });
});
