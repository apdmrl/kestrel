import type { JourneyEvent } from "../domain/journey/journey-event.js";
import type { EventId } from "../domain/shared/identifiers.js";

/** Append-only, replay-safe storage for the engineering journey ledger. */
export interface JourneyStore {
  append(event: JourneyEvent): Promise<void>;
  contains(eventId: EventId): Promise<boolean>;
  readAll(): Promise<JourneyEvent[]>;
}
