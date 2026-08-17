import { describe, expect, it } from "vitest";
import { createChallenge } from "../../domain/challenge/challenge.js";
import { createPullRequestEvidence } from "../../domain/evidence/evidence.js";
import {
  createRecommendation,
  snapshotRecommendation,
} from "../../domain/recommendation/recommendation.js";
import type { Challenge } from "../../domain/challenge/challenge.js";
import type { ChallengeId } from "../../domain/shared/identifiers.js";
import type { EventId } from "../../domain/shared/identifiers.js";
import type { EvidenceId } from "../../domain/evidence/evidence.js";
import type { HandoffId, MissionId, TransactionId } from "../../domain/shared/identifiers.js";
import type { IsoDateTime } from "../../domain/shared/time.js";
import type { RecommendationSnapshot } from "../../domain/recommendation/recommendation.js";
import type { WorkspaceInfo } from "../../domain/mission/mission.js";
import { Mission } from "../../domain/mission/mission.js";
import type { JourneyEvent } from "../../domain/journey/journey-event.js";
import type {
  GitHubGateway,
  GitHubToken,
  GitHubViewer,
  DeviceFlowAuthorization,
  PullRequestInfo,
  IssueLinkResult,
  MergeInfo,
} from "../../ports/github-gateway.js";
import type { JourneyStore } from "../../ports/journey-store.js";
import type { MissionLock } from "../../ports/mission-lock.js";
import type { MissionStore, StoredMission } from "../../ports/mission-store.js";
import type { TransactionJournal } from "../../ports/transaction-journal.js";
import { recordAllPreparationCheckpoints } from "../../test-utils/prepare.js";
import { verifyMerge } from "./verify-merge.js";

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

function submittedMission(): Mission {
  const workspace: WorkspaceInfo = {
    root: "/tmp/ws",
    missionDirectory: "/tmp/ws/m1",
    repositoryPath: "/tmp/ws/m1/repo",
    sidecarPath: "/tmp/ws/m1/kestrel",
  };
  const accepted = Mission.accept({
    id: "m1" as MissionId,
    challengeSnapshot: makeChallenge(),
    recommendationSnapshot: makeRecommendation(makeChallenge()),
    mode: "GUIDED",
    acceptedAt: now,
  });
  const preparing = accepted.ok ? accepted.value.startPreparation() : null;
  const ready = preparing?.ok ? recordAllPreparationCheckpoints(preparing.value) : null;
  const inProgress = ready?.completePreparation({ workspace, baseCommit: "base", branch: "b" });
  const pr = createPullRequestEvidence({
    id: "pr-1" as EvidenceId,
    missionId: "m1" as MissionId,
    observedAt: now,
    number: 99,
    url: "https://github.com/octocat/hello-world/pull/99",
    repository: { provider: "github", owner: "octocat", name: "hello-world" },
    author: "octocat",
    commits: ["abc"],
    state: "OPEN",
  });
  const submitted = inProgress?.ok
    ? inProgress.value.recordSubmitted(pr.ok ? pr.value : ({} as never))
    : null;
  if (!submitted?.ok) {
    throw new Error("expected ok");
  }
  return submitted.value;
}

class FakeGateway implements GitHubGateway {
  merge: MergeInfo = { merged: true, mergeSha: "merge-sha", mergedAt: now };
  async beginDeviceFlow(): Promise<DeviceFlowAuthorization> {
    throw new Error("unused");
  }
  async pollForToken(): Promise<GitHubToken> {
    throw new Error("unused");
  }
  async getViewer(): Promise<GitHubViewer> {
    return { login: "octocat", id: 1 };
  }
  async getPullRequest(): Promise<PullRequestInfo> {
    throw new Error("unused");
  }
  async getIssueLinkage(): Promise<IssueLinkResult | undefined> {
    return undefined;
  }
  async getMergeInfo(): Promise<MergeInfo> {
    return this.merge;
  }
}

class FakeMissionStore implements MissionStore {
  async get(): Promise<StoredMission | undefined> {
    return undefined;
  }
  async save(_p: string, mission: Mission, v: number): Promise<StoredMission> {
    return { mission, version: v + 1 };
  }
}
class FakeJourneyStore implements JourneyStore {
  events: JourneyEvent[] = [];
  async append(e: JourneyEvent): Promise<void> {
    this.events.push(e);
  }
  async contains(): Promise<boolean> {
    return false;
  }
  async readAll(): Promise<JourneyEvent[]> {
    return [...this.events];
  }
}
class FakeJournal implements TransactionJournal {
  async create(): Promise<void> {}
  async advancePhase(): Promise<void> {}
  async get() {
    return undefined;
  }
  async listPending() {
    return [];
  }
  async remove(): Promise<void> {}
}
class NoopLock implements MissionLock {
  async withMissionLock<T>(
    _p: string,
    _m: MissionId,
    _o: string,
    action: () => Promise<T>,
  ): Promise<T> {
    return action();
  }
  async breakStaleLock(_p: string): Promise<void> {}
}
let counter = 0;
const idGenerator = {
  newMissionId: () => ("m" + ++counter) as MissionId,
  newChallengeId: () => ("c" + ++counter) as ChallengeId,
  newEventId: () => ("e" + ++counter) as EventId,
  newHandoffId: () => ("h" + ++counter) as HandoffId,
  newTransactionId: () => ("t" + ++counter) as TransactionId,
  newEvidenceId: () => ("ev" + ++counter) as EvidenceId,
};

function deps(gateway: FakeGateway, journeyStore: JourneyStore = new FakeJourneyStore()) {
  return {
    lock: new NoopLock(),
    journal: new FakeJournal(),
    missionStore: new FakeMissionStore(),
    journeyStore,
    gateway,
    idGenerator,
    clock: { now: () => now },
  };
}

describe("verifyMerge", () => {
  it("records a merge from live evidence", async () => {
    const journey = new FakeJourneyStore();
    const result = await verifyMerge(deps(new FakeGateway(), journey), {
      mission: submittedMission(),
      sidecarPath: "/tmp/ws/m1/kestrel",
      lockPath: "/tmp/ws/m1/kestrel/.lock",
      expectedStateVersion: 0,
      token: "token",
      prNumber: 99,
    });
    expect(result.kind).toBe("merged");
    if (result.kind === "merged") {
      expect(result.mission.submissionVerification).toBe("MERGED");
    }
    expect(journey.events.some((e) => e.type === "PullRequestMerged")).toBe(true);
  });

  it("returns not-merged for an open PR", async () => {
    const gateway = new FakeGateway();
    gateway.merge = { merged: false, mergeSha: undefined, mergedAt: undefined };
    const result = await verifyMerge(deps(gateway), {
      mission: submittedMission(),
      sidecarPath: "/tmp/ws/m1/kestrel",
      lockPath: "/tmp/ws/m1/kestrel/.lock",
      expectedStateVersion: 0,
      token: "token",
      prNumber: 99,
    });
    expect(result.kind).toBe("not-merged");
  });
});
