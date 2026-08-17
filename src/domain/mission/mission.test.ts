import { describe, expect, it } from "vitest";
import { createChallenge } from "../challenge/challenge.js";
import type { ChallengeId } from "../shared/identifiers.js";
import type { MissionId } from "../shared/identifiers.js";
import type { IsoDateTime } from "../shared/time.js";
import { createRecommendation, snapshotRecommendation } from "../recommendation/recommendation.js";
import type { RecommendationSnapshot } from "../recommendation/recommendation.js";
import type { Challenge } from "../challenge/challenge.js";
import type { EvidenceDecision } from "../policy/evidence-decision.js";
import { Mission } from "./mission.js";
import type { WorkspaceInfo } from "./mission.js";

const acceptedAt = "2026-08-15T10:00:00Z" as IsoDateTime;
const accepted: EvidenceDecision = { accepted: true, blockingReasons: [], warnings: [] };
const blocked: EvidenceDecision = {
  accepted: false,
  blockingReasons: ["no local changes"],
  warnings: [],
};

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

function acceptedMission(): Mission {
  const result = Mission.accept({
    id: "m1" as MissionId,
    challengeSnapshot: makeChallenge(),
    recommendationSnapshot: makeRecommendation(makeChallenge()),
    mode: "GUIDED",
    workspaceRoot: "/home/dev/kestrel",
    acceptedAt,
  });
  if (!result.ok) {
    throw new Error("expected ok");
  }
  return result.value;
}

function preparedMission(): Mission {
  const accepted = acceptedMission();
  const preparing = accepted.startPreparation();
  if (!preparing.ok) {
    throw new Error("expected ok");
  }
  const inProgress = preparing.value.completePreparation({
    workspace,
    baseCommit: "base-sha",
    branch: "kestrel/1-fix-crash",
  });
  if (!inProgress.ok) {
    throw new Error("expected ok");
  }
  return inProgress.value;
}

describe("Mission lifecycle", () => {
  it("walks the happy path ACCEPTED → PREPARING → IN_PROGRESS → COMPLETED", () => {
    const mission = acceptedMission();
    expect(mission.status).toBe("ACCEPTED");

    const preparing = mission.startPreparation();
    expect(preparing.ok).toBe(true);
    if (preparing.ok) {
      expect(preparing.value.status).toBe("PREPARING");
    }

    const inProgress = preparing.ok
      ? preparing.value.completePreparation({ workspace, baseCommit: "base-sha", branch: "b" })
      : null;
    expect(inProgress?.ok).toBe(true);
    if (inProgress?.ok) {
      expect(inProgress.value.status).toBe("IN_PROGRESS");
      expect(inProgress.value.immutableBaseCommit).toBe("base-sha");
      expect(inProgress.value.branch).toBe("b");
      expect(inProgress.value.workspace).toEqual(workspace);
    }

    const completed = inProgress?.ok ? inProgress.value.complete(accepted) : null;
    expect(completed?.ok).toBe(true);
    if (completed?.ok) {
      expect(completed.value.status).toBe("COMPLETED");
    }
  });

  it("rejects skipped transitions", () => {
    const mission = acceptedMission();
    expect(mission.completePreparation({ workspace, baseCommit: "x", branch: "b" }).ok).toBe(false);
    expect(mission.complete(accepted).ok).toBe(false);
  });

  it("rejects reversed transitions", () => {
    const mission = acceptedMission();
    expect(mission.startPreparation().ok).toBe(true);

    const preparing = mission.startPreparation();
    if (!preparing.ok) {
      throw new Error("expected ok");
    }
    expect(preparing.value.startPreparation().ok).toBe(false);

    const inProgress = preparing.value.completePreparation({
      workspace,
      baseCommit: "x",
      branch: "b",
    });
    if (!inProgress.ok) {
      throw new Error("expected ok");
    }
    expect(
      inProgress.value.completePreparation({ workspace, baseCommit: "x", branch: "b" }).ok,
    ).toBe(false);
  });

  it("makes abandonment terminal", () => {
    const inProgress = preparedMission();
    const abandoned = inProgress.abandon("no longer interested");
    expect(abandoned.ok).toBe(true);
    if (abandoned.ok) {
      expect(abandoned.value.status).toBe("ABANDONED");
      expect(abandoned.value.abandon("again").ok).toBe(false);
      expect(abandoned.value.startPreparation().ok).toBe(false);
      expect(abandoned.value.complete(accepted).ok).toBe(false);
    }
  });

  it("rejects completion when the evidence decision blocks", () => {
    const inProgress = preparedMission();
    const result = inProgress.complete(blocked);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toContain("EVIDENCE");
    }
  });

  it("snapshots challenge and recommendation immutably", () => {
    const challenge = makeChallenge();
    const recommendation = makeRecommendation(challenge);
    const result = Mission.accept({
      id: "m1" as MissionId,
      challengeSnapshot: challenge,
      recommendationSnapshot: recommendation,
      mode: "GUIDED",
      acceptedAt,
    });
    if (!result.ok) {
      throw new Error("expected ok");
    }
    (challenge as unknown as { title: string }).title = "MUTATED";
    (recommendation as unknown as { reasons: string[] }).reasons[0] = "MUTATED";

    expect(result.value.challengeSnapshot.title).toBe("Fix crash");
    expect(result.value.recommendationSnapshot.reasons[0]).toBe("matches");
  });

  it("keeps repository identity stable across transitions", () => {
    const inProgress = preparedMission();
    expect(inProgress.challengeSnapshot.repository).toEqual({
      provider: "github",
      owner: "o",
      name: "n",
    });
    expect(inProgress.recommendationSnapshot.challenge.repository).toEqual({
      provider: "github",
      owner: "o",
      name: "n",
    });
  });
});
