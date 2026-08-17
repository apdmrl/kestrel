import { describe, expect, it } from "vitest";
import { createChallenge } from "../../domain/challenge/challenge.js";
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
import { Mission } from "../../domain/mission/mission.js";
import type { JourneyEvent } from "../../domain/journey/journey-event.js";
import type { AgentHandoff } from "../../domain/agent/agent-handoff.js";
import type { JourneyStore } from "../../ports/journey-store.js";
import type { MissionLock } from "../../ports/mission-lock.js";
import type { MissionStore, StoredMission } from "../../ports/mission-store.js";
import type { TransactionJournal } from "../../ports/transaction-journal.js";
import { genericPromptRenderer } from "./generic-prompt-renderer.js";
import { recordAgentHandoff } from "./record-agent-handoff.js";
import { FakeIndexStore } from "../../test-utils/fake-index-store.js";

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

function acceptedMission(): Mission {
  const accepted = Mission.accept({
    id: "m1" as MissionId,
    challengeSnapshot: makeChallenge(),
    recommendationSnapshot: makeRecommendation(makeChallenge()),
    mode: "GUIDED",
    acceptedAt: now,
  });
  if (!accepted.ok) {
    throw new Error("expected ok");
  }
  return accepted.value;
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

function deps(saved: AgentHandoff[]) {
  return {
    lock: new NoopLock(),
    journal: new FakeJournal(),
    missionStore: new FakeMissionStore(),
    journeyStore: new FakeJourneyStore(),
    indexStore: new FakeIndexStore(),
    idGenerator,
    clock: { now: () => now },
    renderer: genericPromptRenderer,
    saveHandoff: async (handoff: AgentHandoff) => {
      saved.push(handoff);
    },
  };
}

describe("recordAgentHandoff", () => {
  it("records an immutable handoff with a stable hash", async () => {
    const saved: AgentHandoff[] = [];
    const journey = new FakeJourneyStore();
    const handoff = await recordAgentHandoff(
      { ...deps(saved), journeyStore: journey },
      {
        mission: acceptedMission(),
        sidecarPath: "/tmp/ws/m1/kestrel",
        lockPath: "/tmp/ws/m1/kestrel/.lock",
        expectedStateVersion: 0,
      },
    );
    expect(handoff.schemaVersion).toBe(1);
    expect(handoff.renderedPromptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(saved).toHaveLength(1);
    expect(journey.events.some((e) => e.type === "AgentHandoffRecorded")).toBe(true);
  });

  it("produces a different handoff for a different hypothesis", async () => {
    const saved: AgentHandoff[] = [];
    const first = await recordAgentHandoff(deps(saved), {
      mission: acceptedMission(),
      sidecarPath: "/tmp/ws/m1/kestrel",
      lockPath: "/tmp/ws/m1/kestrel/.lock",
      expectedStateVersion: 0,
      hypothesis: "a null deref",
    });
    const second = await recordAgentHandoff(deps(saved), {
      mission: acceptedMission(),
      sidecarPath: "/tmp/ws/m1/kestrel",
      lockPath: "/tmp/ws/m1/kestrel/.lock",
      expectedStateVersion: 0,
    });
    expect(first.handoffId).not.toBe(second.handoffId);
    expect(first.renderedPromptHash).not.toBe(second.renderedPromptHash);
  });
});
