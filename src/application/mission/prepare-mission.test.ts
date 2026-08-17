import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createChallenge } from "../../domain/challenge/challenge.js";
import type { Challenge } from "../../domain/challenge/challenge.js";
import type { RepositoryIdentity } from "../../domain/challenge/repository-identity.js";
import type { EvidenceId } from "../../domain/evidence/evidence.js";
import { Mission } from "../../domain/mission/mission.js";
import {
  createRecommendation,
  snapshotRecommendation,
} from "../../domain/recommendation/recommendation.js";
import type { RecommendationSnapshot } from "../../domain/recommendation/recommendation.js";
import type {
  ChallengeId,
  EventId,
  HandoffId,
  MissionId,
  TransactionId,
} from "../../domain/shared/identifiers.js";
import type { IsoDateTime } from "../../domain/shared/time.js";
import { createKestrelError } from "../errors/kestrel-error.js";
import type { GitClient, LocalChanges } from "../../ports/git-client.js";
import type { MissionStore, StoredMission } from "../../ports/mission-store.js";
import { FileMissionLock } from "../../infrastructure/locking/file-mission-lock.js";
import { FileSystemMissionStore } from "../../infrastructure/persistence/file-system-mission-store.js";
import { JsonlJourneyStore } from "../../infrastructure/persistence/jsonl-journey-store.js";
import { FileTransactionJournal } from "../../infrastructure/transactions/file-transaction-journal.js";
import { FilesystemWorkspaceManager } from "../../infrastructure/workspace/filesystem-workspace-manager.js";
import {
  prepareMission,
  restartConfirmationToken,
  restartMissionPreparation,
  resumeMissionPreparation,
} from "./prepare-mission.js";
import { FakeIndexStore } from "../../test-utils/fake-index-store.js";

const now = "2026-08-15T10:00:00Z" as IsoDateTime;
const repository: RepositoryIdentity = {
  provider: "github",
  owner: "octocat",
  name: "hello-world",
};

function makeChallenge(): Challenge {
  const result = createChallenge({
    id: "c1" as ChallengeId,
    externalId: "1",
    repository,
    issueNumber: 42,
    canonicalUrl: "https://github.com/octocat/hello-world/issues/42",
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
    evaluatedAt: now,
  });
  if (!result.ok) {
    throw new Error("expected ok");
  }
  return snapshotRecommendation(result.value);
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

function gitFatal(): ReturnType<typeof createKestrelError> {
  return createKestrelError({
    code: "DM_GIT_FATAL",
    category: "EXTERNAL_STATE_CHANGED",
    userMessage: "not a git repository",
    suggestedActions: ["inspect"],
    retryability: "NO_RETRY",
    recoveryStrategy: "MANUAL_INTERVENTION",
    severity: "ERROR",
  });
}

class FakeGit implements GitClient {
  cloneCalls = 0;
  createBranchCalls = 0;
  checkoutCalls = 0;
  cloned = false;
  branch = "main";
  branches = new Set<string>(["main"]);
  baseSha = "base-sha";
  identity: RepositoryIdentity = { ...repository };
  failOn: string | undefined = undefined;

  private failIf(op: string): void {
    if (this.failOn === op) {
      this.failOn = undefined;
      throw new Error("injected failure: " + op);
    }
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
  async clone(_url: string, _target: string): Promise<void> {
    this.cloneCalls += 1;
    this.failIf("clone");
    this.cloned = true;
  }
  async getDefaultBranch(): Promise<string> {
    this.failIf("getDefaultBranch");
    return "main";
  }
  async getHeadSha(): Promise<string> {
    this.failIf("getHeadSha");
    return this.baseSha;
  }
  async createBranch(name: string): Promise<void> {
    this.createBranchCalls += 1;
    this.failIf("createBranch");
    this.branches.add(name);
    this.branch = name;
  }
  async branchExists(name: string): Promise<boolean> {
    this.failIf("branchExists");
    return this.branches.has(name);
  }
  async checkoutBranch(name: string): Promise<void> {
    this.checkoutCalls += 1;
    this.failIf("checkoutBranch");
    this.branch = name;
  }
  async getRepositoryIdentity(): Promise<RepositoryIdentity> {
    this.failIf("getRepositoryIdentity");
    if (!this.cloned) {
      throw gitFatal();
    }
    return this.identity;
  }
  async collectChangesSince(_base: string): Promise<LocalChanges> {
    return {
      commits: [],
      headSha: this.baseSha,
      filesChanged: [],
      insertions: 0,
      deletions: 0,
      workingTreeState: "CLEAN",
    };
  }
  async getCurrentBranch(): Promise<string> {
    this.failIf("getCurrentBranch");
    return this.branch;
  }
  async commitExists(sha: string): Promise<boolean> {
    return sha === this.baseSha;
  }
}

class FaultySaveStore implements MissionStore {
  constructor(
    private readonly inner: MissionStore,
    private readonly failWhenCheckpoint?: string,
  ) {}

  async get(path: string): Promise<StoredMission | undefined> {
    return this.inner.get(path);
  }

  async save(path: string, mission: Mission, version: number): Promise<StoredMission> {
    if (
      this.failWhenCheckpoint !== undefined &&
      mission.preparationCheckpoints.some((c) => c.checkpoint === this.failWhenCheckpoint)
    ) {
      throw new Error("injected save failure at " + this.failWhenCheckpoint);
    }
    return this.inner.save(path, mission, version);
  }
}

async function makeHarness() {
  const dir = await mkdtemp(join(tmpdir(), "kestrel-prep-"));
  const workspaceRoot = join(dir, "ws");
  const missionStore = new FileSystemMissionStore();
  const journeyStore = new JsonlJourneyStore(join(dir, "journey", "events.jsonl"));
  const journal = new FileTransactionJournal(join(dir, "transactions"));
  const lock = new FileMissionLock();
  const workspaceManager = new FilesystemWorkspaceManager();
  const indexStore = new FakeIndexStore();

  async function seed(missionId: MissionId) {
    const accepted = Mission.accept({
      id: missionId,
      challengeSnapshot: makeChallenge(),
      recommendationSnapshot: makeRecommendation(makeChallenge()),
      mode: "GUIDED",
      workspaceRoot,
      acceptedAt: now,
    });
    if (!accepted.ok) {
      throw new Error("expected ok");
    }
    const plan = workspaceManager.planWorkspace(workspaceRoot, missionId, repository, 42);
    await missionStore.save(plan.sidecarPath, accepted.value, 0);
    return { sidecarPath: plan.sidecarPath, plan };
  }

  function deps(git: FakeGit, overrides: { missionStore?: MissionStore } = {}) {
    return {
      lock,
      journal,
      missionStore: overrides.missionStore ?? missionStore,
      journeyStore,
      indexStore,
      workspaceManager,
      idGenerator,
      clock: { now: () => now },
      gitFactory: () => git,
    };
  }

  async function cleanup(): Promise<void> {
    await rm(dir, { recursive: true, force: true });
  }

  return { missionStore, journeyStore, workspaceManager, seed, deps, cleanup };
}

describe("prepareMission (durable, resumable)", () => {
  it("prepares a persisted ACCEPTED mission to IN_PROGRESS with real adapters", async () => {
    const h = await makeHarness();
    try {
      const { sidecarPath } = await h.seed("m1" as MissionId);
      const git = new FakeGit();
      const mission = await prepareMission(h.deps(git), {
        missionId: "m1" as MissionId,
        sidecarPath,
      });
      expect(mission.status).toBe("IN_PROGRESS");
      expect(mission.preparationCheckpoints).toHaveLength(7);
      expect(git.cloneCalls).toBe(1);
      expect(git.createBranchCalls).toBe(1);
      const events = await h.journeyStore.readAll();
      expect(events.some((e) => e.type === "MissionPreparationStarted")).toBe(true);
      expect(events.some((e) => e.type === "MissionPreparationCompleted")).toBe(true);
    } finally {
      await h.cleanup();
    }
  });

  it("resumes after a clone interruption, reusing persisted checkpoints", async () => {
    const h = await makeHarness();
    try {
      const missionId = "m1" as MissionId;
      const { sidecarPath } = await h.seed(missionId);
      const git = new FakeGit();
      git.failOn = "clone";
      await expect(prepareMission(h.deps(git), { missionId, sidecarPath })).rejects.toMatchObject({
        code: "DM_MISSION_PREPARATION_INTERRUPTED",
      });

      const stored = await h.missionStore.get(sidecarPath);
      expect(stored?.mission.status).toBe("PREPARING");
      expect(stored?.mission.preparationCheckpoints.map((c) => c.checkpoint)).toEqual([
        "WORKSPACE_CREATED",
      ]);

      const resumed = await resumeMissionPreparation(h.deps(git), { missionId, sidecarPath });
      expect(resumed.status).toBe("IN_PROGRESS");
      expect(git.cloneCalls).toBe(2); // one failed attempt, one successful resume
    } finally {
      await h.cleanup();
    }
  });

  it("does not re-clone when resuming after the clone checkpoint", async () => {
    const h = await makeHarness();
    try {
      const missionId = "m1" as MissionId;
      const { sidecarPath } = await h.seed(missionId);
      const git = new FakeGit();
      git.failOn = "getHeadSha"; // clone succeeds, then base recording fails
      await expect(prepareMission(h.deps(git), { missionId, sidecarPath })).rejects.toMatchObject({
        code: "DM_MISSION_PREPARATION_INTERRUPTED",
      });
      expect(git.cloneCalls).toBe(1);

      const resumed = await resumeMissionPreparation(h.deps(git), { missionId, sidecarPath });
      expect(resumed.status).toBe("IN_PROGRESS");
      expect(git.cloneCalls).toBe(1); // clone verified and skipped, never re-cloned
    } finally {
      await h.cleanup();
    }
  });

  it("rejects restart without a matching confirmation", async () => {
    const h = await makeHarness();
    try {
      const missionId = "m1" as MissionId;
      const { sidecarPath } = await h.seed(missionId);
      const git = new FakeGit();
      git.failOn = "getHeadSha";
      await expect(prepareMission(h.deps(git), { missionId, sidecarPath })).rejects.toMatchObject({
        code: "DM_MISSION_PREPARATION_INTERRUPTED",
      });
      await expect(
        restartMissionPreparation(h.deps(git), { missionId, sidecarPath, confirmation: "wrong" }),
      ).rejects.toMatchObject({ code: "DM_ILLEGAL_TRANSITION" });
    } finally {
      await h.cleanup();
    }
  });

  it("restart resets checkpoints and reuses the existing clone", async () => {
    const h = await makeHarness();
    try {
      const missionId = "m1" as MissionId;
      const { sidecarPath } = await h.seed(missionId);
      const git = new FakeGit();
      git.failOn = "getHeadSha";
      await expect(prepareMission(h.deps(git), { missionId, sidecarPath })).rejects.toMatchObject({
        code: "DM_MISSION_PREPARATION_INTERRUPTED",
      });

      const token = restartConfirmationToken(missionId, sidecarPath);
      const reset = await restartMissionPreparation(h.deps(git), {
        missionId,
        sidecarPath,
        confirmation: token,
      });
      expect(reset.status).toBe("PREPARING");
      expect(reset.preparationCheckpoints).toHaveLength(0);

      const again = await resumeMissionPreparation(h.deps(git), { missionId, sidecarPath });
      expect(again.status).toBe("IN_PROGRESS");
      expect(git.cloneCalls).toBe(1); // the clone was never deleted or rewritten
    } finally {
      await h.cleanup();
    }
  });

  it("never clones over an existing unrelated repository", async () => {
    const h = await makeHarness();
    try {
      const missionId = "m1" as MissionId;
      const { sidecarPath } = await h.seed(missionId);
      const git = new FakeGit();
      git.cloned = true;
      git.identity = { provider: "github", owner: "someone", name: "else" };
      await expect(prepareMission(h.deps(git), { missionId, sidecarPath })).rejects.toMatchObject({
        code: "DM_REPOSITORY_MISMATCH",
      });
      expect(git.cloneCalls).toBe(0);
    } finally {
      await h.cleanup();
    }
  });

  it("propagates illegal transitions instead of silently discarding them", async () => {
    const h = await makeHarness();
    try {
      const missionId = "m1" as MissionId;
      const { sidecarPath } = await h.seed(missionId);
      const git = new FakeGit();
      await prepareMission(h.deps(git), { missionId, sidecarPath });
      await expect(prepareMission(h.deps(git), { missionId, sidecarPath })).rejects.toMatchObject({
        code: "DM_ILLEGAL_TRANSITION",
      });
    } finally {
      await h.cleanup();
    }
  });

  it("converges after interruption at every external checkpoint", async () => {
    for (const failOn of ["clone", "getHeadSha", "createBranch"]) {
      const h = await makeHarness();
      try {
        const missionId = "m1" as MissionId;
        const { sidecarPath } = await h.seed(missionId);
        const git = new FakeGit();
        git.failOn = failOn;
        await expect(prepareMission(h.deps(git), { missionId, sidecarPath })).rejects.toMatchObject(
          {
            code: "DM_MISSION_PREPARATION_INTERRUPTED",
          },
        );
        const resumed = await resumeMissionPreparation(h.deps(git), { missionId, sidecarPath });
        expect(resumed.status).toBe("IN_PROGRESS");
        expect(resumed.preparationCheckpoints).toHaveLength(7);
      } finally {
        await h.cleanup();
      }
    }
  });

  it("does not duplicate the clone when a save fails right after it", async () => {
    const h = await makeHarness();
    try {
      const missionId = "m1" as MissionId;
      const { sidecarPath } = await h.seed(missionId);
      const git = new FakeGit();
      const faulty = new FaultySaveStore(h.missionStore, "REPOSITORY_CLONED");
      await expect(
        prepareMission(h.deps(git, { missionStore: faulty }), { missionId, sidecarPath }),
      ).rejects.toMatchObject({ code: "DM_MISSION_PREPARATION_INTERRUPTED" });
      expect(git.cloneCalls).toBe(1);

      const resumed = await resumeMissionPreparation(h.deps(git), { missionId, sidecarPath });
      expect(resumed.status).toBe("IN_PROGRESS");
      expect(git.cloneCalls).toBe(1); // the already-cloned repository was reused
    } finally {
      await h.cleanup();
    }
  });

  it("converges after a branch-creation save failure without recreating the branch", async () => {
    const h = await makeHarness();
    try {
      const missionId = "m1" as MissionId;
      const { sidecarPath, plan } = await h.seed(missionId);
      const git = new FakeGit();
      const faulty = new FaultySaveStore(h.missionStore, "BRANCH_CREATED");
      await expect(
        prepareMission(h.deps(git, { missionStore: faulty }), { missionId, sidecarPath }),
      ).rejects.toMatchObject({ code: "DM_MISSION_PREPARATION_INTERRUPTED" });
      expect(git.createBranchCalls).toBe(1);
      expect(git.branch).toBe(plan.branchName);

      const resumed = await resumeMissionPreparation(h.deps(git), { missionId, sidecarPath });
      expect(resumed.status).toBe("IN_PROGRESS");
      expect(git.createBranchCalls).toBe(1); // reconciled, never recreated
      expect(git.branch).toBe(plan.branchName);
    } finally {
      await h.cleanup();
    }
  });

  it("restart after branch creation converges to the intended branch", async () => {
    const h = await makeHarness();
    try {
      const missionId = "m1" as MissionId;
      const { sidecarPath, plan } = await h.seed(missionId);
      const git = new FakeGit();
      const faulty = new FaultySaveStore(h.missionStore, "CONTEXT_COLLECTED");
      await expect(
        prepareMission(h.deps(git, { missionStore: faulty }), { missionId, sidecarPath }),
      ).rejects.toMatchObject({ code: "DM_MISSION_PREPARATION_INTERRUPTED" });
      expect(git.createBranchCalls).toBe(1);
      expect(git.branch).toBe(plan.branchName);

      const token = restartConfirmationToken(missionId, sidecarPath);
      await restartMissionPreparation(h.deps(git), {
        missionId,
        sidecarPath,
        confirmation: token,
      });

      const again = await resumeMissionPreparation(h.deps(git), { missionId, sidecarPath });
      expect(again.status).toBe("IN_PROGRESS");
      expect(git.createBranchCalls).toBe(1); // branch reconciled, never recreated
      expect(git.branch).toBe(plan.branchName);
    } finally {
      await h.cleanup();
    }
  });

  it("records the branch checkpoint without creating when already on the intended branch", async () => {
    const h = await makeHarness();
    try {
      const missionId = "m1" as MissionId;
      const { sidecarPath, plan } = await h.seed(missionId);
      const git = new FakeGit();
      git.cloned = true;
      git.branch = plan.branchName;
      git.branches.add(plan.branchName);

      const mission = await prepareMission(h.deps(git), { missionId, sidecarPath });
      expect(mission.status).toBe("IN_PROGRESS");
      expect(git.createBranchCalls).toBe(0);
      expect(git.checkoutCalls).toBe(0);
    } finally {
      await h.cleanup();
    }
  });

  it("checks out the intended branch when it exists but another is checked out", async () => {
    const h = await makeHarness();
    try {
      const missionId = "m1" as MissionId;
      const { sidecarPath, plan } = await h.seed(missionId);
      const git = new FakeGit();
      git.branches.add(plan.branchName); // intended branch exists, "main" stays checked out

      const mission = await prepareMission(h.deps(git), { missionId, sidecarPath });
      expect(mission.status).toBe("IN_PROGRESS");
      expect(git.createBranchCalls).toBe(0);
      expect(git.checkoutCalls).toBe(1);
      expect(git.branch).toBe(plan.branchName);
    } finally {
      await h.cleanup();
    }
  });

  it("fails without deleting the clone when the checked-out branch is unexpected", async () => {
    const h = await makeHarness();
    try {
      const missionId = "m1" as MissionId;
      const { sidecarPath, plan } = await h.seed(missionId);
      const git = new FakeGit();
      const faulty = new FaultySaveStore(h.missionStore, "CONTEXT_COLLECTED");
      await expect(
        prepareMission(h.deps(git, { missionStore: faulty }), { missionId, sidecarPath }),
      ).rejects.toMatchObject({ code: "DM_MISSION_PREPARATION_INTERRUPTED" });
      expect(git.branch).toBe(plan.branchName);

      git.branch = "other";
      git.branches.add("other");
      await expect(
        resumeMissionPreparation(h.deps(git), { missionId, sidecarPath }),
      ).rejects.toMatchObject({ code: "DM_REPOSITORY_MISMATCH" });
      expect(git.cloneCalls).toBe(1);
      expect(git.cloned).toBe(true);
    } finally {
      await h.cleanup();
    }
  });

  it("verifies the recorded branch name exactly, not merely nonempty", async () => {
    const h = await makeHarness();
    try {
      const missionId = "m1" as MissionId;
      const { sidecarPath } = await h.seed(missionId);
      const git = new FakeGit();
      const faulty = new FaultySaveStore(h.missionStore, "CONTEXT_COLLECTED");
      await expect(
        prepareMission(h.deps(git, { missionStore: faulty }), { missionId, sidecarPath }),
      ).rejects.toMatchObject({ code: "DM_MISSION_PREPARATION_INTERRUPTED" });

      git.branch = "main"; // nonempty, but not the recorded branch
      await expect(
        resumeMissionPreparation(h.deps(git), { missionId, sidecarPath }),
      ).rejects.toMatchObject({ code: "DM_REPOSITORY_MISMATCH" });
    } finally {
      await h.cleanup();
    }
  });
});
