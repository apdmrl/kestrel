import type { JourneyEvent } from "../../domain/journey/journey-event.js";
import type { JourneyStore } from "../../ports/journey-store.js";
import { projectJourney, type JourneySummary } from "./journey-projector.js";

export interface GetJourneyDeps {
  readonly journeyStore: JourneyStore;
}

export async function getJourney(deps: GetJourneyDeps): Promise<JourneySummary[]> {
  const events: JourneyEvent[] = await deps.journeyStore.readAll();
  return projectJourney(events);
}
