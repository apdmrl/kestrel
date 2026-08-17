import { describe, expect, it } from "vitest";
import { createChallenge } from "../../domain/challenge/challenge.js";
import type { JourneyEvent } from "../../domain/journey/journey-event.js";
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
import type { GitClient, LocalChanges } from "../../ports/git-client.js";
import type { RepositoryIdentity } from "../../domain/challenge/repository-identity.js";
import type { JourneyStore } from "../../ports/journey-store.js";
import type { MissionLock } from "../../ports/mission-lock.js";
import type { MissionStore, StoredMission } from "../../ports/mission-store.js";
import type { TransactionJournal } from "../../ports/transaction-journal.js";
import { recordAllPreparationCheckpoints } from "../../test-utils/prepare.js";
import { completeMission } from "./complete-mission.js";
import { FakeIndexStore } from "../../test-utils/fake-index-store.js";

const now = "2026-08-15T10:00:00Z" as IsoDateTime;

function makeChallenge(type: "BUG_FIX" | "TESTING" | "DOCUMENTATION" = "BUG_FIX"): Challenge {
  const result = createChallenge({
    id: "c1" as ChallengeId,
    externalId: "1",
    repository: { provider: "github", owner: "octocat", name: "hello-world" },
    issueNumber: 42,
    canonicalUrl: "https://github.com/octocat/hello-world/issues/42",
    title: "Fix crash",
    description: "d",
    type,
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

function inProgressMission(type: "BUG_FIX" | "TESTING" | "DOCUMENTATION" = "BUG_FIX"): Mission {
  const workspace: WorkspaceInfo = {
    root: "/tmp/ws",
    missionDirectory: "/tmp/ws/m1",
    repositoryPath: "/tmp/ws/m1/repo",
    sidecarPath: "/tmp/ws/m1/kestrel",
  };
  const accepted = Mission.accept({
    id: "m1" as MissionId,
    challengeSnapshot: makeChallenge(type),
    recommendationSnapshot: makeRecommendation(makeChallenge(type)),
    mode: "GUIDED",
    acceptedAt: now,
  });
  const preparing = accepted.ok ? accepted.value.startPreparation() : null;
  const ready = preparing?.ok ? recordAllPreparationCheckpoints(preparing.value) : null;
  const inProgress = ready?.completePreparation({ workspace, baseCommit: "base-sha", branch: "b" });
  if (!inProgress?.ok) {
    throw new Error("expected ok");
  }
  return inProgress.value;
}

class FakeGit implements GitClient {
  changes: LocalChanges = {
    commits: ["c1"],
    headSha: "head",
    filesChanged: ["a.ts"],
    insertions: 2,
    deletions: 0,
    workingTreeState: "CLEAN",
  };
  identity: RepositoryIdentity = { provider: "github", owner: "octocat", name: "hello-world" };
  async isAvailable() {
    return true;
  }
  async clone(): Promise<void> {}
  async getDefaultBranch() {
    return "main";
  }
  async getHeadSha() {
    return "head";
  }
  async createBranch(): Promise<void> {}
  async getRepositoryIdentity() {
    return this.identity;
  }
  async collectChangesSince() {
    return this.changes;
  }
  async getCurrentBranch() {
    return "main";
  }
  async commitExists() {
    return true;
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

function deps(git: FakeGit) {
  return {
    lock: new NoopLock(),
    journal: new FakeJournal(),
    missionStore: new FakeMissionStore(),
    journeyStore: new FakeJourneyStore(),
    indexStore: new FakeIndexStore(),
    git,
    idGenerator,
    clock: { now: () => now },
  };
}

describe("completeMission", () => {
  it("completes a mission with sufficient evidence", async () => {
    const journey = new FakeJourneyStore();
    const mission = await completeMission(
      { ...deps(new FakeGit()), journeyStore: journey },
      {
        mission: inProgressMission(),
        sidecarPath: "/tmp/ws/m1/kestrel",
        lockPath: "/tmp/ws/m1/kestrel/.lock",
        expectedStateVersion: 0,
      },
    );
    expect(mission.status).toBe("COMPLETED");
    expect(journey.events.some((e) => e.type === "MissionCompleted")).toBe(true);
  });

  it("rejects completion with no changes", async () => {
    const git = new FakeGit();
    git.changes = {
      commits: [],
      headSha: "head",
      filesChanged: [],
      insertions: 0,
      deletions: 0,
      workingTreeState: "CLEAN",
    };
    await expect(
      completeMission(deps(git), {
        mission: inProgressMission(),
        sidecarPath: "/tmp/ws/m1/kestrel",
        lockPath: "/tmp/ws/m1/kestrel/.lock",
        expectedStateVersion: 0,
      }),
    ).rejects.toMatchObject({ code: "DM_EVIDENCE_BLOCKED" });
  });

  it("completes a testing mission only with a test-file change", async () => {
    const git = new FakeGit();
    git.changes = {
      commits: ["c1"],
      headSha: "head",
      filesChanged: ["src/app.ts"],
      insertions: 2,
      deletions: 0,
      workingTreeState: "CLEAN",
    };
    await expect(
      completeMission(deps(git), {
        mission: inProgressMission("TESTING"),
        sidecarPath: "/tmp/ws/m1/kestrel",
        lockPath: "/tmp/ws/m1/kestrel/.lock",
        expectedStateVersion: 0,
      }),
    ).rejects.toMatchObject({ code: "DM_EVIDENCE_BLOCKED" });
  });
});
