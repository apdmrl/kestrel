import { createJourneyEvent } from "../../domain/journey/journey-event.js";
import type { Mission } from "../../domain/mission/mission.js";
import type { Clock } from "../../ports/clock.js";
import type { IdGenerator } from "../../ports/id-generator.js";
import type { JourneyStore } from "../../ports/journey-store.js";
import type { MissionLock } from "../../ports/mission-lock.js";
import type { MissionStore } from "../../ports/mission-store.js";
import type { TransactionJournal } from "../../ports/transaction-journal.js";
import { createKestrelError } from "../errors/kestrel-error.js";
import { commitMissionChange } from "../transactions/commit-mission-change.js";

export interface AbandonMissionDeps {
  readonly lock: MissionLock;
  readonly journal: TransactionJournal;
  readonly missionStore: MissionStore;
  readonly journeyStore: JourneyStore;
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
}

export interface AbandonMissionInput {
  readonly mission: Mission;
  readonly sidecarPath: string;
  readonly lockPath: string;
  readonly expectedStateVersion: number;
  readonly reason: string;
}

/** Abandon a non-terminal active mission transactionally. */
export async function abandonMission(
  deps: AbandonMissionDeps,
  input: AbandonMissionInput,
): Promise<Mission> {
  const abandoned = input.mission.abandon(input.reason);
  if (!abandoned.ok) {
    throw createKestrelError({
      code: "DM_ILLEGAL_TRANSITION",
      category: "INVALID_INPUT",
      userMessage: abandoned.error.message,
      suggestedActions: ["Check the current mission state"],
      retryability: "NO_RETRY",
      recoveryStrategy: "USER_ACTION",
      severity: "ERROR",
    });
  }
  const event = createJourneyEvent({
    eventId: deps.idGenerator.newEventId(),
    missionId: input.mission.id,
    type: "MissionAbandoned",
    occurredAt: deps.clock.now(),
    payload: { reason: input.reason },
  });
  if (!event.ok) {
    throw createKestrelError({
      code: "DM_STATE_CORRUPTED",
      category: "FATAL",
      userMessage: "Failed to build the abandonment event",
      suggestedActions: [],
      retryability: "NO_RETRY",
      recoveryStrategy: "MANUAL_INTERVENTION",
      severity: "FATAL",
    });
  }
  await commitMissionChange(
    {
      lock: deps.lock,
      journal: deps.journal,
      missionStore: deps.missionStore,
      journeyStore: deps.journeyStore,
    },
    {
      transactionId: deps.idGenerator.newTransactionId(),
      missionId: input.mission.id,
      sidecarPath: input.sidecarPath,
      operation: "abandon",
      expectedStateVersion: input.expectedStateVersion,
      targetMission: abandoned.value,
      event: event.value,
    },
  );
  return abandoned.value;
}
