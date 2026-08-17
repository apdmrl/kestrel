import { describe, expect, it } from "vitest";
import { createChallenge } from "../../domain/challenge/challenge.js";
import { createJourneyEvent } from "../../domain/journey/journey-event.js";
import type { JourneyEvent } from "../../domain/journey/journey-event.js";
import {
  createRecommendation,
  snapshotRecommendation,
} from "../../domain/recommendation/recommendation.js";
import type { Challenge } from "../../domain/challenge/challenge.js";
import type { ChallengeId } from "../../domain/shared/identifiers.js";
import type { EventId } from "../../domain/shared/identifiers.js";
import type { MissionId } from "../../domain/shared/identifiers.js";
import type { TransactionId } from "../../domain/shared/identifiers.js";
import type { IsoDateTime } from "../../domain/shared/time.js";
import type { RecommendationSnapshot } from "../../domain/recommendation/recommendation.js";
import type { WorkspaceInfo } from "../../domain/mission/mission.js";
import { Mission } from "../../domain/mission/mission.js";
import type { JourneyStore } from "../../ports/journey-store.js";
import type { MissionLock } from "../../ports/mission-lock.js";
import type { MissionStore, StoredMission } from "../../ports/mission-store.js";
import type {
  NewTransactionIntent,
  TransactionIntent,
  TransactionJournal,
  TransactionPhase,
} from "../../ports/transaction-journal.js";
import { createKestrelError } from "../errors/kestrel-error.js";
import { recordAllPreparationCheckpoints } from "../../test-utils/prepare.js";
import { commitMissionChange, type MissionChange } from "./commit-mission-change.js";
import { recoverTransactions } from "./recover-transactions.js";
import { FakeIndexStore } from "../../test-utils/fake-index-store.js";

const acceptedAt = "2026-08-15T10:00:00Z" as IsoDateTime;
const sidecarPath = "/tmp/mission/kestrel";

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

function preparedMission(): Mission {
  const workspace: WorkspaceInfo = {
    root: "/tmp/mission",
    missionDirectory: "/tmp/mission/m1",
    repositoryPath: "/tmp/mission/m1/repo",
    sidecarPath,
  };
  const accepted = Mission.accept({
    id: "m1" as MissionId,
    challengeSnapshot: makeChallenge(),
    recommendationSnapshot: makeRecommendation(makeChallenge()),
    mode: "GUIDED",
    acceptedAt,
  });
  const preparing = accepted.ok ? accepted.value.startPreparation() : null;
  const inProgress = preparing?.ok
    ? recordAllPreparationCheckpoints(preparing.value).completePreparation({
        workspace,
        baseCommit: "base",
        branch: "b",
      })
    : null;
  if (!inProgress?.ok) {
    throw new Error("expected ok");
  }
  return inProgress.value;
}

function journeyEvent(): JourneyEvent {
  const result = createJourneyEvent({
    eventId: "e1" as EventId,
    missionId: "m1" as MissionId,
    type: "MissionCompleted",
    occurredAt: acceptedAt,
  });
  if (!result.ok) {
    throw new Error("expected ok");
  }
  return result.value;
}

function change(): MissionChange {
  return {
    transactionId: "t1" as TransactionId,
    missionId: "m1" as MissionId,
    sidecarPath,
    operation: "complete",
    expectedStateVersion: 0,
    targetMission: preparedMission(),
    event: journeyEvent(),
  };
}

class FakeMissionStore implements MissionStore {
  readonly versions = new Map<string, number>();
  readonly missions = new Map<string, Mission>();
  saveCount = 0;
  failNextSave = false;

  async get(path: string): Promise<StoredMission | undefined> {
    const version = this.versions.get(path);
    if (version === undefined) {
      return undefined;
    }
    return { mission: this.missions.get(path) as Mission, version };
  }

  async save(path: string, mission: Mission, expectedVersion: number): Promise<StoredMission> {
    this.saveCount += 1;
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("injected save failure");
    }
    const current = this.versions.get(path) ?? 0;
    if (current !== expectedVersion) {
      throw createKestrelError({
        code: "DM_STORE_CONFLICT",
        category: "CONFLICT",
        userMessage: "conflict",
        suggestedActions: ["reload"],
        retryability: "NO_RETRY",
        recoveryStrategy: "USER_ACTION",
        severity: "ERROR",
      });
    }
    this.versions.set(path, expectedVersion + 1);
    this.missions.set(path, mission);
    return { mission, version: expectedVersion + 1 };
  }
}

class FakeJourneyStore implements JourneyStore {
  readonly events: JourneyEvent[] = [];
  appendCount = 0;
  failNextAppend = false;

  async append(event: JourneyEvent): Promise<void> {
    this.appendCount += 1;
    if (this.failNextAppend) {
      this.failNextAppend = false;
      throw new Error("injected append failure");
    }
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

interface MutableIntent {
  transactionId: TransactionId;
  eventId: EventId;
  missionId: MissionId;
  sidecarPath: string;
  expectedStateVersion: number;
  targetMission: Mission;
  event: JourneyEvent;
  phase: TransactionPhase;
}

class FakeJournal implements TransactionJournal {
  readonly intents = new Map<string, MutableIntent>();

  async create(intent: NewTransactionIntent): Promise<void> {
    this.intents.set(intent.transactionId, { ...intent, phase: "PREPARED" });
  }

  async advancePhase(transactionId: TransactionId, phase: TransactionPhase): Promise<void> {
    const intent = this.intents.get(transactionId);
    if (intent === undefined) {
      throw new Error("not found");
    }
    intent.phase = phase;
  }

  async get(transactionId: TransactionId): Promise<TransactionIntent | undefined> {
    return this.intents.get(transactionId);
  }

  async listPending(): Promise<TransactionIntent[]> {
    return [...this.intents.values()];
  }

  async remove(transactionId: TransactionId): Promise<void> {
    this.intents.delete(transactionId);
  }
}

class NoopLock implements MissionLock {
  async withMissionLock<T>(
    _lockPath: string,
    _missionId: MissionId,
    _operation: string,
    action: () => Promise<T>,
  ): Promise<T> {
    return action();
  }

  async breakStaleLock(_lockPath: string): Promise<void> {}
}

function deps() {
  return {
    lock: new NoopLock(),
    journal: new FakeJournal(),
    missionStore: new FakeMissionStore(),
    journeyStore: new FakeJourneyStore(),
    indexStore: new FakeIndexStore(),
  };
}

describe("commitMissionChange", () => {
  it("writes state and event then removes the intent", async () => {
    const d = deps();
    await commitMissionChange(d, change());
    expect(d.missionStore.saveCount).toBe(1);
    expect(d.journeyStore.appendCount).toBe(1);
    expect(await d.journal.listPending()).toHaveLength(0);
  });

  it("recovers from a crash during the state write", async () => {
    const d = deps();
    d.missionStore.failNextSave = true;
    await expect(commitMissionChange(d, change())).rejects.toThrow();
    expect(d.missionStore.saveCount).toBe(1);
    expect(d.journeyStore.appendCount).toBe(0);
    expect(await d.journal.listPending()).toHaveLength(1);

    await recoverTransactions(d);
    expect(d.missionStore.saveCount).toBe(2);
    expect(d.journeyStore.appendCount).toBe(1);
    expect(await d.journal.listPending()).toHaveLength(0);
  });

  it("recovers from a crash during the event append without rewriting state", async () => {
    const d = deps();
    d.journeyStore.failNextAppend = true;
    await expect(commitMissionChange(d, change())).rejects.toThrow();
    expect(d.missionStore.saveCount).toBe(1);
    expect(d.journeyStore.appendCount).toBe(1);

    await recoverTransactions(d);
    expect(d.missionStore.saveCount).toBe(1);
    expect(d.journeyStore.appendCount).toBe(2);
    expect(await d.journal.listPending()).toHaveLength(0);
  });

  it("converges idempotently to exactly one state and one event", async () => {
    const d = deps();
    const c = change();
    await d.journal.create({
      transactionId: c.transactionId,
      eventId: c.event.eventId,
      missionId: c.missionId,
      sidecarPath: c.sidecarPath,
      expectedStateVersion: c.expectedStateVersion,
      targetMission: c.targetMission,
      event: c.event,
    });
    await recoverTransactions(d);
    await recoverTransactions(d);
    expect(d.missionStore.saveCount).toBe(1);
    expect(d.journeyStore.appendCount).toBe(1);
    expect(await d.journal.listPending()).toHaveLength(0);
  });
});
