import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createChallenge } from "../../domain/challenge/challenge.js";
import type { Challenge } from "../../domain/challenge/challenge.js";
import { createRecommendation } from "../../domain/recommendation/recommendation.js";
import type { Recommendation } from "../../domain/recommendation/recommendation.js";
import type { ChallengeId } from "../../domain/shared/identifiers.js";
import type { EventId } from "../../domain/shared/identifiers.js";
import type { EvidenceId } from "../../domain/evidence/evidence.js";
import type { HandoffId, MissionId, TransactionId } from "../../domain/shared/identifiers.js";
import type { IsoDateTime } from "../../domain/shared/time.js";
import { FileMissionLock } from "../../infrastructure/locking/file-mission-lock.js";
import { FileSystemMissionStore } from "../../infrastructure/persistence/file-system-mission-store.js";
import { FileSystemMissionIndexStore } from "../../infrastructure/persistence/file-system-mission-index-store.js";
import { JsonlJourneyStore } from "../../infrastructure/persistence/jsonl-journey-store.js";
import { FileTransactionJournal } from "../../infrastructure/transactions/file-transaction-journal.js";
import { acceptMission } from "./accept-mission.js";
import { abandonMission } from "./abandon-mission.js";
import { getCurrentMission } from "./get-current-mission.js";
import { recoverTransactions } from "../transactions/recover-transactions.js";

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

function makeRecommendation(): Recommendation {
  const result = createRecommendation({
    challenge: makeChallenge(),
    mood: "QUICK_WIN",
    signalResults: [{ name: "interest", value: 0.9, confidence: 0.8, reason: "matches" }],
    confidence: 0.8,
    evaluatedAt: now,
  });
  if (!result.ok) {
    throw new Error("expected ok");
  }
  return result.value;
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

async function makeHarness() {
  const dir = await mkdtemp(join(tmpdir(), "kestrel-index-"));
  const missionStore = new FileSystemMissionStore();
  const indexStore = new FileSystemMissionIndexStore(join(dir, "index.json"));
  const journeyStore = new JsonlJourneyStore(join(dir, "journey", "events.jsonl"));
  const journal = new FileTransactionJournal(join(dir, "transactions"));
  const lock = new FileMissionLock();
  const workspaceManager = {
    planWorkspace: (root: string, missionId: string) => ({
      root,
      missionDirectory: join(root, missionId),
      repositoryPath: join(root, missionId, "repo"),
      sidecarPath: join(root, missionId, "kestrel"),
      branchName: "kestrel/42-hello-world",
    }),
    assertSafePath: () => undefined,
    createSidecar: async () => undefined,
  };
  const deps = {
    lock,
    journal,
    missionStore,
    journeyStore,
    indexStore,
    workspaceManager,
    idGenerator,
    clock: { now: () => now },
  };
  return { dir, missionStore, indexStore, journeyStore, journal, lock, workspaceManager, deps };
}

describe("mission index maintenance", () => {
  it("creates an index entry on acceptance and resolves it three ways", async () => {
    const h = await makeHarness();
    try {
      const mission = await acceptMission(h.deps, {
        recommendation: makeRecommendation(),
        mode: "GUIDED",
        workspaceRoot: join(h.dir, "ws"),
      });
      const { index } = await h.indexStore.get();
      expect(index.entries).toHaveLength(1);
      const entry = index.entries[0];
      expect(entry?.missionId).toBe(mission.id);
      expect(entry?.status).toBe("ACCEPTED");
      expect(entry?.repository).toEqual({
        provider: "github",
        owner: "octocat",
        name: "hello-world",
      });

      const byId = await getCurrentMission(
        { missionStore: h.missionStore, missionIndexStore: h.indexStore },
        { missionId: mission.id },
      );
      expect(byId.kind).toBe("mission");

      const sidecarPath = entry?.sidecarPath as string;
      const repoPath = join(sidecarPath, "..", "repo");
      const byCwd = await getCurrentMission(
        { missionStore: h.missionStore, missionIndexStore: h.indexStore },
        { cwd: repoPath },
      );
      expect(byCwd.kind).toBe("mission");

      const byActive = await getCurrentMission(
        { missionStore: h.missionStore, missionIndexStore: h.indexStore },
        {},
      );
      expect(byActive.kind).toBe("mission");
    } finally {
      await rm(h.dir, { recursive: true, force: true });
    }
  });

  it("updates the index status on abandonment", async () => {
    const h = await makeHarness();
    try {
      const mission = await acceptMission(h.deps, {
        recommendation: makeRecommendation(),
        mode: "GUIDED",
        workspaceRoot: join(h.dir, "ws"),
      });
      const sidecarPath = join(h.dir, "ws", mission.id, "kestrel");
      await abandonMission(h.deps, {
        mission,
        sidecarPath,
        lockPath: join(sidecarPath, ".lock"),
        expectedStateVersion: 1,
        reason: "lost interest",
      });
      const { index } = await h.indexStore.get();
      expect(index.entries[0]?.status).toBe("ABANDONED");
    } finally {
      await rm(h.dir, { recursive: true, force: true });
    }
  });

  it("converges the index during recovery after an interrupted accept", async () => {
    const h = await makeHarness();
    try {
      // Fail the first index write so accept is interrupted after mission state write.
      const originalSave = h.indexStore.save.bind(h.indexStore);
      let failed = false;
      h.indexStore.save = async (index, version) => {
        if (!failed) {
          failed = true;
          throw new Error("injected index failure");
        }
        return originalSave(index, version);
      };

      await expect(
        acceptMission(h.deps, {
          recommendation: makeRecommendation(),
          mode: "GUIDED",
          workspaceRoot: join(h.dir, "ws"),
        }),
      ).rejects.toThrow();

      const pendingBefore = await h.journal.listPending();
      expect(pendingBefore.length).toBeGreaterThan(0);

      await recoverTransactions({
        lock: h.lock,
        journal: h.journal,
        missionStore: h.missionStore,
        journeyStore: h.journeyStore,
        indexStore: h.indexStore,
      });

      const { index } = await h.indexStore.get();
      expect(index.entries).toHaveLength(1);
      expect(await h.journal.listPending()).toHaveLength(0);
    } finally {
      await rm(h.dir, { recursive: true, force: true });
    }
  });
});
