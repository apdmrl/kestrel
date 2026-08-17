import type { EventId } from "../shared/identifiers.js";
import type { MissionId } from "../shared/identifiers.js";
import type { DomainResult } from "../shared/result.js";
import { err, ok } from "../shared/result.js";
import type { IsoDateTime } from "../shared/time.js";

export const JOURNEY_EVENT_TYPES = [
  "MissionAccepted",
  "MissionPreparationStarted",
  "MissionPreparationCompleted",
  "MissionCompleted",
  "MissionAbandoned",
  "PullRequestSubmitted",
  "IssueLinkVerified",
  "PullRequestMerged",
  "AgentHandoffRecorded",
  "ReflectionAdded",
] as const;

export type JourneyEventType = (typeof JOURNEY_EVENT_TYPES)[number];

/** An immutable entry in the append-only engineering ledger. */
export interface JourneyEvent {
  readonly schemaVersion: 1;
  readonly eventId: EventId;
  readonly missionId: MissionId;
  readonly type: JourneyEventType;
  readonly occurredAt: IsoDateTime;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface CreateJourneyEventInput {
  readonly eventId: EventId;
  readonly missionId: MissionId;
  readonly type: JourneyEventType;
  readonly occurredAt: IsoDateTime;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export function createJourneyEvent(input: CreateJourneyEventInput): DomainResult<JourneyEvent> {
  if (input.eventId.trim().length === 0) {
    return err("DM_INVALID_EVENT", "event id must not be empty");
  }
  if (input.missionId.trim().length === 0) {
    return err("DM_INVALID_EVENT", "mission id must not be empty");
  }
  if (input.occurredAt.trim().length === 0) {
    return err("DM_INVALID_EVENT", "occurredAt must not be empty");
  }
  return ok({
    schemaVersion: 1,
    eventId: input.eventId,
    missionId: input.missionId,
    type: input.type,
    occurredAt: input.occurredAt,
    payload: { ...(input.payload ?? {}) },
  });
}
