import { z } from "zod";
import { isoDateTimeSchema } from "./evidence-schema.js";
import { JOURNEY_EVENT_TYPES } from "../../../domain/journey/journey-event.js";

export const journeyEventSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().min(1),
  missionId: z.string().min(1),
  type: z.enum(JOURNEY_EVENT_TYPES),
  occurredAt: isoDateTimeSchema,
  payload: z.record(z.string(), z.unknown()),
});

export type PersistedJourneyEvent = z.infer<typeof journeyEventSchema>;
