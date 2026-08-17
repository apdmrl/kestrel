import type { JourneyEvent } from "../../domain/journey/journey-event.js";
import type { MissionId } from "../../domain/shared/identifiers.js";
import type { IsoDateTime } from "../../domain/shared/time.js";

export interface JourneySummary {
  readonly missionId: MissionId;
  readonly type: JourneyEvent["type"];
  readonly occurredAt: IsoDateTime;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ProgressCounts {
  readonly accepted: number;
  readonly completed: number;
  readonly submitted: number;
  readonly linked: number;
  readonly merged: number;
  readonly abandoned: number;
}

/** Project events into chronological, replay-safe summaries. */
export function projectJourney(events: readonly JourneyEvent[]): JourneySummary[] {
  const seen = new Set<string>();
  const summaries: JourneySummary[] = [];
  for (const event of events) {
    if (seen.has(event.eventId)) {
      continue;
    }
    seen.add(event.eventId);
    summaries.push({
      missionId: event.missionId,
      type: event.type,
      occurredAt: event.occurredAt,
      payload: { ...event.payload },
    });
  }
  return summaries.sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : 1));
}

function distinctMissions(events: readonly JourneyEvent[], type: JourneyEvent["type"]): number {
  return new Set(events.filter((event) => event.type === type).map((event) => event.missionId))
    .size;
}

/** Count distinct missions per outcome; never computes XP, rank, or impact. */
export function projectProgress(events: readonly JourneyEvent[]): ProgressCounts {
  return {
    accepted: distinctMissions(events, "MissionAccepted"),
    completed: distinctMissions(events, "MissionCompleted"),
    submitted: distinctMissions(events, "PullRequestSubmitted"),
    linked: distinctMissions(events, "IssueLinkVerified"),
    merged: distinctMissions(events, "PullRequestMerged"),
    abandoned: distinctMissions(events, "MissionAbandoned"),
  };
}
