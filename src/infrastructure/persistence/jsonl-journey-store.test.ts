import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createJourneyEvent,
  JOURNEY_EVENT_TYPES,
  type JourneyEventType,
} from "../../domain/journey/journey-event.js";
import type { EventId } from "../../domain/shared/identifiers.js";
import type { MissionId } from "../../domain/shared/identifiers.js";
import type { IsoDateTime } from "../../domain/shared/time.js";
import { JsonlJourneyStore } from "./jsonl-journey-store.js";

const occurredAt = "2026-08-15T10:00:00Z" as IsoDateTime;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kestrel-journey-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function event(type: JourneyEventType, id: string): ReturnType<typeof createJourneyEvent> {
  return createJourneyEvent({
    eventId: id as EventId,
    missionId: "m1" as MissionId,
    type,
    occurredAt,
    payload: { note: type },
  });
}

describe("JsonlJourneyStore", () => {
  it("appends and reads back every initial event type", async () => {
    const store = new JsonlJourneyStore(join(dir, "events.jsonl"));
    for (let i = 0; i < JOURNEY_EVENT_TYPES.length; i++) {
      const created = event(JOURNEY_EVENT_TYPES[i] as JourneyEventType, "e" + i);
      if (!created.ok) {
        throw new Error("expected ok");
      }
      await store.append(created.value);
    }
    const events = await store.readAll();
    expect(events.map((e) => e.type)).toEqual(JOURNEY_EVENT_TYPES);
    expect(events).toHaveLength(JOURNEY_EVENT_TYPES.length);
  });

  it("writes one JSON object per line", async () => {
    const store = new JsonlJourneyStore(join(dir, "events.jsonl"));
    const first = event("MissionAccepted", "e1");
    const second = event("MissionCompleted", "e2");
    if (!first.ok || !second.ok) {
      throw new Error("expected ok");
    }
    await store.append(first.value);
    await store.append(second.value);
    const raw = await readFile(join(dir, "events.jsonl"), "utf8");
    const lines = raw.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("is idempotent when replaying a duplicate event id", async () => {
    const store = new JsonlJourneyStore(join(dir, "events.jsonl"));
    const first = event("MissionAccepted", "e1");
    if (!first.ok) {
      throw new Error("expected ok");
    }
    await store.append(first.value);
    await store.append(first.value);
    const events = await store.readAll();
    expect(events).toHaveLength(1);
    expect(await store.contains("e1" as EventId)).toBe(true);
  });

  it("classifies a truncated final line as corrupt", async () => {
    const filePath = join(dir, "events.jsonl");
    const good = event("MissionAccepted", "e1");
    if (!good.ok) {
      throw new Error("expected ok");
    }
    await new JsonlJourneyStore(filePath).append(good.value);
    await writeFile(filePath, '{"schemaVersion":1,"eventId":"e2","missi', "utf8");

    const store = new JsonlJourneyStore(filePath);
    await expect(store.readAll()).rejects.toMatchObject({ code: "DM_STATE_CORRUPTED" });
  });

  it("preserves chronological read order", async () => {
    const store = new JsonlJourneyStore(join(dir, "events.jsonl"));
    const types: JourneyEventType[] = [
      "MissionAccepted",
      "MissionPreparationStarted",
      "MissionCompleted",
    ];
    for (let i = 0; i < types.length; i++) {
      const created = event(types[i] as JourneyEventType, "e" + i);
      if (!created.ok) {
        throw new Error("expected ok");
      }
      await store.append(created.value);
    }
    const events = await store.readAll();
    expect(events.map((e) => e.eventId)).toEqual(["e0", "e1", "e2"]);
  });
});
