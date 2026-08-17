import { describe, expect, it } from "vitest";
import { createChallenge } from "../../../domain/challenge/challenge.js";
import type { ChallengeId } from "../../../domain/shared/identifiers.js";
import type { MissionId } from "../../../domain/shared/identifiers.js";
import type { IsoDateTime } from "../../../domain/shared/time.js";
import {
  createRecommendation,
  snapshotRecommendation,
} from "../../../domain/recommendation/recommendation.js";
import type { Challenge } from "../../../domain/challenge/challenge.js";
import type { RecommendationSnapshot } from "../../../domain/recommendation/recommendation.js";
import type { MissionStatus } from "../../../domain/mission/mission-status.js";
import { Mission } from "../../../domain/mission/mission.js";
import type { WorkspaceInfo } from "../../../domain/mission/mission.js";
import type { EvidenceId } from "../../../domain/evidence/evidence.js";
import {
  createPullRequestEvidence,
  createMergeEvidence,
} from "../../../domain/evidence/evidence.js";
import { fromPersistedMission, toPersistedMission } from "./mission-mapper.js";
import { recordAllPreparationCheckpoints } from "../../../test-utils/prepare.js";

const acceptedAt = "2026-08-15T10:00:00Z" as IsoDateTime;

const workspace: WorkspaceInfo = {
  root: "/home/dev/kestrel",
  missionDirectory: "/home/dev/kestrel/m-1",
  repositoryPath: "/home/dev/kestrel/m-1/repo",
  sidecarPath: "/home/dev/kestrel/m-1/kestrel",
};

function makeChallenge(): Challenge {
  const result = createChallenge({
    id: "c1" as ChallengeId,
    externalId: "1",
    repository: { provider: "github", owner: "o", name: "n" },
    issueNumber: 1,
    canonicalUrl: "https://github.com/o/n/issues/1",
    title: "Fix crash",
    description: "desc",
    type: "BUG_FIX",
    labels: ["bug"],
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

function buildMission(status: MissionStatus): Mission {
  const accept = Mission.accept({
    id: "m1" as MissionId,
    challengeSnapshot: makeChallenge(),
    recommendationSnapshot: makeRecommendation(makeChallenge()),
    mode: "GUIDED",
    workspaceRoot: "/home/dev/kestrel",
    acceptedAt,
  });
  if (!accept.ok) {
    throw new Error("expected ok");
  }
  if (status === "ACCEPTED") {
    return accept.value;
  }
  const preparing = accept.value.startPreparation();
  if (!preparing.ok) {
    throw new Error("expected ok");
  }
  if (status === "PREPARING") {
    return preparing.value;
  }
  const inProgress = recordAllPreparationCheckpoints(preparing.value).completePreparation({
    workspace,
    baseCommit: "base-sha",
    branch: "kestrel/1-fix-crash",
  });
  if (!inProgress.ok) {
    throw new Error("expected ok");
  }
  if (status === "IN_PROGRESS") {
    return inProgress.value;
  }
  if (status === "COMPLETED") {
    const completed = inProgress.value.complete({
      accepted: true,
      blockingReasons: [],
      warnings: [],
    });
    if (!completed.ok) {
      throw new Error("expected ok");
    }
    return completed.value;
  }
  const abandoned = inProgress.value.abandon("lost interest");
  if (!abandoned.ok) {
    throw new Error("expected ok");
  }
  return abandoned.value;
}

describe("mission mapper", () => {
  it.each(["ACCEPTED", "PREPARING", "IN_PROGRESS", "COMPLETED", "ABANDONED"] as MissionStatus[])(
    "round-trips a %s mission",
    (status) => {
      const mission = buildMission(status);
      const persisted = toPersistedMission(mission);
      expect(persisted.schemaVersion).toBe(1);

      const restored = fromPersistedMission(persisted);
      expect(restored.ok).toBe(true);
      if (restored.ok) {
        expect(restored.value.status).toBe(status);
        expect(toPersistedMission(restored.value)).toEqual(persisted);
      }
    },
  );

  it("round-trips verification evidence", () => {
    const mission = buildMission("IN_PROGRESS");
    const pr = createPullRequestEvidence({
      id: "pr-1" as EvidenceId,
      missionId: "m1" as MissionId,
      observedAt: acceptedAt,
      number: 99,
      url: "https://github.com/o/n/pull/99",
      repository: { provider: "github", owner: "o", name: "n" },
      author: "dev",
      commits: ["abc"],
      state: "OPEN",
    });
    const submitted = mission.recordSubmitted(pr.ok ? pr.value : ({} as never));
    const merge = createMergeEvidence({
      id: "merge-1" as EvidenceId,
      missionId: "m1" as MissionId,
      observedAt: acceptedAt,
      pullRequestNumber: 99,
      repository: { provider: "github", owner: "o", name: "n" },
      mergeSha: "merge-sha",
      mergedAt: acceptedAt,
    });
    const merged = submitted.ok
      ? submitted.value.recordMerged(merge.ok ? merge.value : ({} as never))
      : null;
    if (!merged?.ok) {
      throw new Error("expected ok");
    }
    const persisted = toPersistedMission(merged.value);
    const restored = fromPersistedMission(persisted);
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(restored.value.submissionVerification).toBe("MERGED");
      expect(toPersistedMission(restored.value)).toEqual(persisted);
    }
  });

  it("rejects rehydration with mismatched merge and submitted pull requests", () => {
    const mission = buildMission("IN_PROGRESS");
    const pr = createPullRequestEvidence({
      id: "pr-1" as EvidenceId,
      missionId: "m1" as MissionId,
      observedAt: acceptedAt,
      number: 99,
      url: "https://github.com/o/n/pull/99",
      repository: { provider: "github", owner: "o", name: "n" },
      author: "dev",
      commits: ["abc"],
      state: "OPEN",
    });
    const submitted = mission.recordSubmitted(pr.ok ? pr.value : ({} as never));
    const merge = createMergeEvidence({
      id: "merge-1" as EvidenceId,
      missionId: "m1" as MissionId,
      observedAt: acceptedAt,
      pullRequestNumber: 99,
      repository: { provider: "github", owner: "o", name: "n" },
      mergeSha: "merge-sha",
      mergedAt: acceptedAt,
    });
    const merged = submitted.ok
      ? submitted.value.recordMerged(merge.ok ? merge.value : ({} as never))
      : null;
    if (!merged?.ok) {
      throw new Error("expected ok");
    }
    const persisted = toPersistedMission(merged.value);
    const mismatched = {
      ...persisted,
      mergeEvidence: { ...persisted.mergeEvidence, pullRequestNumber: 100 },
    };
    expect(fromPersistedMission(mismatched).ok).toBe(false);
  });

  it("rejects an unknown future schema version", () => {
    const persisted = toPersistedMission(buildMission("ACCEPTED"));
    const result = fromPersistedMission({ ...persisted, schemaVersion: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("DM_STATE_VERSION_UNSUPPORTED");
    }
  });

  it("rejects malformed state", () => {
    expect(fromPersistedMission({ schemaVersion: 1, id: "" }).ok).toBe(false);
    expect(fromPersistedMission(null).ok).toBe(false);
    expect(fromPersistedMission("garbage").ok).toBe(false);
  });

  it("rejects a mission that violates lifecycle invariants on rehydration", () => {
    const persisted = toPersistedMission(buildMission("ACCEPTED"));
    const invalid = { ...persisted, status: "IN_PROGRESS" };
    const result = fromPersistedMission(invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toContain("MISSION");
    }
  });
});
