import type { JourneyEvent } from "../domain/journey/journey-event.js";
import type { Mission } from "../domain/mission/mission.js";
import type { EventId, MissionId, TransactionId } from "../domain/shared/identifiers.js";

export type TransactionPhase = "PREPARED" | "STATE_WRITTEN" | "EVENT_APPENDED";

export interface TransactionIntent {
  readonly transactionId: TransactionId;
  readonly eventId: EventId;
  readonly missionId: MissionId;
  readonly expectedStateVersion: number;
  readonly targetMission: Mission;
  readonly event: JourneyEvent;
  readonly phase: TransactionPhase;
}

export interface NewTransactionIntent {
  readonly transactionId: TransactionId;
  readonly eventId: EventId;
  readonly missionId: MissionId;
  readonly expectedStateVersion: number;
  readonly targetMission: Mission;
  readonly event: JourneyEvent;
}

/**
 * Durable intent log for cross-file Mission/Journey mutations. Recovery replays
 * these intents to finish whichever half of the update was not completed.
 */
export interface TransactionJournal {
  create(intent: NewTransactionIntent): Promise<void>;
  advancePhase(transactionId: TransactionId, phase: TransactionPhase): Promise<void>;
  get(transactionId: TransactionId): Promise<TransactionIntent | undefined>;
  listPending(): Promise<TransactionIntent[]>;
  remove(transactionId: TransactionId): Promise<void>;
}
