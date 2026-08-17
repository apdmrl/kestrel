import { createJourneyEvent } from "../../../domain/journey/journey-event.js";
import type { JourneyEvent } from "../../../domain/journey/journey-event.js";
import type { EventId } from "../../../domain/shared/identifiers.js";
import type { MissionId } from "../../../domain/shared/identifiers.js";
import type { DomainResult } from "../../../domain/shared/result.js";
import { err } from "../../../domain/shared/result.js";
import type { IsoDateTime } from "../../../domain/shared/time.js";
import { journeyEventSchema, type PersistedJourneyEvent } from "../schemas/journey-event-schema.js";

export function toPersistedJourneyEvent(event: JourneyEvent): PersistedJourneyEvent {
  return {
    schemaVersion: 1,
    eventId: event.eventId,
    missionId: event.missionId,
    type: event.type,
    occurredAt: event.occurredAt,
    payload: { ...event.payload },
  };
}

export function fromPersistedJourneyEvent(data: unknown): DomainResult<JourneyEvent> {
  const parsed = journeyEventSchema.safeParse(data);
  if (!parsed.success) {
    return err("DM_STATE_CORRUPTED", "journey event failed schema validation");
  }
  return createJourneyEvent({
    eventId: parsed.data.eventId as EventId,
    missionId: parsed.data.missionId as MissionId,
    type: parsed.data.type,
    occurredAt: parsed.data.occurredAt as IsoDateTime,
    payload: parsed.data.payload,
  });
}
