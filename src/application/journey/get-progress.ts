import type { JourneyEvent } from "../../domain/journey/journey-event.js";
import type { JourneyStore } from "../../ports/journey-store.js";
import { projectProgress, type ProgressCounts } from "./journey-projector.js";

export interface GetProgressDeps {
  readonly journeyStore: JourneyStore;
}

export async function getProgress(deps: GetProgressDeps): Promise<ProgressCounts> {
  const events: JourneyEvent[] = await deps.journeyStore.readAll();
  return projectProgress(events);
}
