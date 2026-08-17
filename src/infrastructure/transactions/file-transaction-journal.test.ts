import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createChallenge } from "../../domain/challenge/challenge.js";
import { createJourneyEvent } from "../../domain/journey/journey-event.js";
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
import type { JourneyEvent } from "../../domain/journey/journey-event.js";
import { FileTransactionJournal } from "./file-transaction-journal.js";
import { recordAllPreparationCheckpoints } from "../../test-utils/prepare.js";

const acceptedAt = "2026-08-15T10:00:00Z" as IsoDateTime;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kestrel-txn-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

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
    root: dir,
    missionDirectory: join(dir, "m1"),
    repositoryPath: join(dir, "m1", "repo"),
    sidecarPath: join(dir, "m1", "kestrel"),
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

function intent(transactionId: string) {
  return {
    transactionId: transactionId as TransactionId,
    eventId: "e1" as EventId,
    missionId: "m1" as MissionId,
    sidecarPath: join(dir, "m1", "kestrel"),
    expectedStateVersion: 1,
    targetMission: preparedMission(),
    event: journeyEvent(),
  };
}

describe("FileTransactionJournal", () => {
  it("creates an intent in the PREPARED phase atomically", async () => {
    const journal = new FileTransactionJournal(join(dir, "transactions"));
    await journal.create(intent("t1"));
    const loaded = await journal.get("t1" as TransactionId);
    expect(loaded?.phase).toBe("PREPARED");
    expect(loaded?.transactionId).toBe("t1");
    expect(loaded?.expectedStateVersion).toBe(1);
  });

  it("advances phases legally", async () => {
    const journal = new FileTransactionJournal(join(dir, "transactions"));
    await journal.create(intent("t1"));
    await journal.advancePhase("t1" as TransactionId, "STATE_WRITTEN");
    await journal.advancePhase("t1" as TransactionId, "EVENT_APPENDED");
    const loaded = await journal.get("t1" as TransactionId);
    expect(loaded?.phase).toBe("EVENT_APPENDED");
  });

  it("replays an identical phase idempotently", async () => {
    const journal = new FileTransactionJournal(join(dir, "transactions"));
    await journal.create(intent("t1"));
    await journal.advancePhase("t1" as TransactionId, "STATE_WRITTEN");
    await journal.advancePhase("t1" as TransactionId, "STATE_WRITTEN");
    const loaded = await journal.get("t1" as TransactionId);
    expect(loaded?.phase).toBe("STATE_WRITTEN");
  });

  it("rejects illegal regression", async () => {
    const journal = new FileTransactionJournal(join(dir, "transactions"));
    await journal.create(intent("t1"));
    await journal.advancePhase("t1" as TransactionId, "STATE_WRITTEN");
    await journal.advancePhase("t1" as TransactionId, "EVENT_APPENDED");
    await expect(
      journal.advancePhase("t1" as TransactionId, "STATE_WRITTEN"),
    ).rejects.toMatchObject({ code: "DM_STATE_CORRUPTED" });
  });

  it("lists pending intents", async () => {
    const journal = new FileTransactionJournal(join(dir, "transactions"));
    await journal.create(intent("t1"));
    await journal.create(intent("t2"));
    const pending = await journal.listPending();
    expect(pending).toHaveLength(2);
  });

  it("removes an intent on completion cleanup", async () => {
    const journal = new FileTransactionJournal(join(dir, "transactions"));
    await journal.create(intent("t1"));
    await journal.remove("t1" as TransactionId);
    await expect(journal.get("t1" as TransactionId)).resolves.toBeUndefined();
    const pending = await journal.listPending();
    expect(pending).toHaveLength(0);
  });
});
