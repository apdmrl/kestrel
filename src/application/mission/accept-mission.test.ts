import { describe, expect, it } from "vitest";
import { createChallenge } from "../../domain/challenge/challenge.js";
import type { Challenge } from "../../domain/challenge/challenge.js";
import type { JourneyEvent } from "../../domain/journey/journey-event.js";
import { createRecommendation } from "../../domain/recommendation/recommendation.js";
import type { Recommendation } from "../../domain/recommendation/recommendation.js";
import type { ChallengeId } from "../../domain/shared/identifiers.js";
import type { EventId } from "../../domain/shared/identifiers.js";
import type { EvidenceId } from "../../domain/evidence/evidence.js";
import type { HandoffId, MissionId, TransactionId } from "../../domain/shared/identifiers.js";
import type { IsoDateTime } from "../../domain/shared/time.js";
import type { Mission } from "../../domain/mission/mission.js";
import type { JourneyStore } from "../../ports/journey-store.js";
import type { MissionLock } from "../../ports/mission-lock.js";
import type { MissionStore, StoredMission } from "../../ports/mission-store.js";
import type {
  NewTransactionIntent,
  TransactionIntent,
  TransactionJournal,
  TransactionPhase,
} from "../../ports/transaction-journal.js";
import { acceptMission } from "./accept-mission.js";

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
    labels: ["bug"],
    language: "typescript",
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

class FakeMissionStore implements MissionStore {
  readonly saved: { mission: Mission; version: number }[] = [];
  failNextSave = false;

  async get(): Promise<StoredMission | undefined> {
    return undefined;
  }

  async save(_path: string, mission: Mission, expectedVersion: number): Promise<StoredMission> {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("injected failure");
    }
    this.saved.push({ mission, version: expectedVersion + 1 });
    return { mission, version: expectedVersion + 1 };
  }
}

class FakeJourneyStore implements JourneyStore {
  readonly events: JourneyEvent[] = [];
  async append(event: JourneyEvent): Promise<void> {
    if (!this.events.some((e) => e.eventId === event.eventId)) {
      this.events.push(event);
    }
  }
  async contains(eventId: EventId): Promise<boolean> {
    return this.events.some((e) => e.eventId === eventId);
  }
  async readAll(): Promise<JourneyEvent[]> {
    return [...this.events];
  }
}

class FakeJournal implements TransactionJournal {
  intents = new Map<string, { phase: TransactionPhase }>();
  async create(intent: NewTransactionIntent): Promise<void> {
    this.intents.set(intent.transactionId, { phase: "PREPARED" });
  }
  async advancePhase(_id: TransactionId, phase: TransactionPhase): Promise<void> {
    const intent = this.intents.get(_id);
    if (intent) {
      intent.phase = phase;
    }
  }
  async get(_id: TransactionId): Promise<TransactionIntent | undefined> {
    return undefined;
  }
  async listPending(): Promise<TransactionIntent[]> {
    return [];
  }
  async remove(id: TransactionId): Promise<void> {
    this.intents.delete(id);
  }
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

const workspaceManager = {
  planWorkspace: (root: string, missionId: string) => ({
    root,
    missionDirectory: root + "/" + missionId,
    repositoryPath: root + "/" + missionId + "/repo",
    sidecarPath: root + "/" + missionId + "/kestrel",
    branchName: "kestrel/42-hello-world",
  }),
  assertSafePath: () => undefined,
  createSidecar: async () => undefined,
};

function deps() {
  return {
    lock: new NoopLock(),
    journal: new FakeJournal(),
    missionStore: new FakeMissionStore(),
    journeyStore: new FakeJourneyStore(),
    workspaceManager,
    idGenerator,
    clock: { now: () => now },
  };
}

describe("acceptMission", () => {
  it("persists an ACCEPTED mission and one MissionAccepted event", async () => {
    const d = deps();
    const mission = await acceptMission(d, {
      recommendation: makeRecommendation(),
      mode: "GUIDED",
      workspaceRoot: "/tmp/ws",
    });
    expect(mission.status).toBe("ACCEPTED");
    expect(d.missionStore.saved).toHaveLength(1);
    expect(d.journeyStore.events).toHaveLength(1);
    expect(d.journeyStore.events[0]?.type).toBe("MissionAccepted");
  });

  it("snapshots the recommendation immutably", async () => {
    const d = deps();
    const recommendation = makeRecommendation();
    const mission = await acceptMission(d, {
      recommendation,
      mode: "GUIDED",
      workspaceRoot: "/tmp/ws",
    });
    (recommendation.challenge as unknown as { title: string }).title = "MUTATED";
    expect(mission.challengeSnapshot.title).toBe("Fix crash");
  });

  it("records mode and repository in the event payload", async () => {
    const d = deps();
    await acceptMission(d, {
      recommendation: makeRecommendation(),
      mode: "EXPERT",
      workspaceRoot: "/tmp/ws",
    });
    const payload = d.journeyStore.events[0]?.payload as { mode: string; repository: unknown };
    expect(payload.mode).toBe("EXPERT");
    expect(payload.repository).toEqual({
      provider: "github",
      owner: "octocat",
      name: "hello-world",
    });
  });

  it("deduplicates a repeated idempotency key", async () => {
    const d = deps();
    const key = "idem-1" as EventId;
    await acceptMission(d, {
      recommendation: makeRecommendation(),
      mode: "GUIDED",
      workspaceRoot: "/tmp/ws",
      idempotencyKey: key,
    });
    await acceptMission(d, {
      recommendation: makeRecommendation(),
      mode: "GUIDED",
      workspaceRoot: "/tmp/ws",
      idempotencyKey: key,
    });
    expect(d.journeyStore.events.filter((e) => e.eventId === key)).toHaveLength(1);
  });

  it("propagates a transaction failure", async () => {
    const d = deps();
    d.missionStore.failNextSave = true;
    await expect(
      acceptMission(d, {
        recommendation: makeRecommendation(),
        mode: "GUIDED",
        workspaceRoot: "/tmp/ws",
      }),
    ).rejects.toThrow();
  });
});
