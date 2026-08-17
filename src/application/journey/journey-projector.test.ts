import { describe, expect, it } from "vitest";
import { createJourneyEvent } from "../../domain/journey/journey-event.js";
import type { JourneyEvent, JourneyEventType } from "../../domain/journey/journey-event.js";
import type { EventId } from "../../domain/shared/identifiers.js";
import type { MissionId } from "../../domain/shared/identifiers.js";
import type { IsoDateTime } from "../../domain/shared/time.js";
import { projectJourney, projectProgress } from "./journey-projector.js";

const t = "2026-08-15T10:00:00Z" as IsoDateTime;

function event(
  id: string,
  mission: string,
  type: JourneyEventType,
  occurredAt: IsoDateTime = t,
): JourneyEvent {
  const result = createJourneyEvent({
    eventId: id as EventId,
    missionId: mission as MissionId,
    type,
    occurredAt,
  });
  if (!result.ok) {
    throw new Error("expected ok");
  }
  return result.value;
}

describe("projectJourney", () => {
  it("returns an empty journey for no events", () => {
    expect(projectJourney([])).toEqual([]);
  });

  it("deduplicates a replayed event and orders chronologically", () => {
    const a = event("e1", "m1", "MissionAccepted", "2026-08-01T00:00:00Z" as IsoDateTime);
    const b = event("e2", "m1", "MissionCompleted", "2026-08-02T00:00:00Z" as IsoDateTime);
    const summary = projectJourney([b, a, a]);
    expect(summary).toHaveLength(2);
    expect(summary[0]?.type).toBe("MissionAccepted");
  });
});

describe("projectProgress", () => {
  it("counts each outcome from a full lifecycle", () => {
    const events = [
      event("e1", "m1", "MissionAccepted"),
      event("e2", "m1", "MissionCompleted"),
      event("e3", "m1", "PullRequestSubmitted"),
      event("e4", "m1", "IssueLinkVerified"),
      event("e5", "m1", "PullRequestMerged"),
    ];
    const progress = projectProgress(events);
    expect(progress).toEqual({
      accepted: 1,
      completed: 1,
      submitted: 1,
      linked: 1,
      merged: 1,
      abandoned: 0,
    });
  });

  it("counts a merged mission without a link", () => {
    const events = [
      event("e1", "m1", "MissionAccepted"),
      event("e2", "m1", "PullRequestSubmitted"),
      event("e3", "m1", "PullRequestMerged"),
    ];
    const progress = projectProgress(events);
    expect(progress.merged).toBe(1);
    expect(progress.linked).toBe(0);
  });

  it("never computes a score or impact", () => {
    const serialized = JSON.stringify(projectProgress([]));
    expect(serialized).not.toContain("score");
    expect(serialized).not.toContain("impact");
    expect(serialized).not.toContain("xp");
  });
});
