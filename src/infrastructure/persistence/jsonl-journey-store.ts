import { mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { createKestrelError } from "../../application/errors/kestrel-error.js";
import type { JourneyEvent } from "../../domain/journey/journey-event.js";
import type { EventId } from "../../domain/shared/identifiers.js";
import type { JourneyStore } from "../../ports/journey-store.js";
import {
  fromPersistedJourneyEvent,
  toPersistedJourneyEvent,
} from "./mappers/journey-event-mapper.js";

function corruptError(message: string): ReturnType<typeof createKestrelError> {
  return createKestrelError({
    code: "DM_STATE_CORRUPTED",
    category: "RECOVERABLE_STATE",
    userMessage: message,
    suggestedActions: ["Restore the ledger from the automatic backup"],
    retryability: "NO_RETRY",
    recoveryStrategy: "MANUAL_INTERVENTION",
    severity: "ERROR",
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export class JsonlJourneyStore implements JourneyStore {
  constructor(private readonly filePath: string) {}

  async append(event: JourneyEvent): Promise<void> {
    if (await this.contains(event.eventId)) {
      return;
    }
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const wasNew = !(await exists(this.filePath));
    const line = JSON.stringify(toPersistedJourneyEvent(event)) + "\n";

    const handle = await open(this.filePath, "a");
    try {
      await handle.writeFile(line, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    if (wasNew) {
      // Make the ledger file's directory entry durable as well.
      const dirHandle = await open(directory, "r");
      try {
        await dirHandle.sync();
      } catch {
        // Directory fsync is best-effort on filesystems that reject it.
      } finally {
        await dirHandle.close();
      }
    }
  }

  async contains(eventId: EventId): Promise<boolean> {
    const lines = await this.readRawLines();
    for (const line of lines) {
      if (line.trim() === "") {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as { eventId?: string };
        if (parsed.eventId === eventId) {
          return true;
        }
      } catch {
        // Ignore unparseable lines here; readAll classifies them.
      }
    }
    return false;
  }

  async readAll(): Promise<JourneyEvent[]> {
    const lines = await this.readRawLines();
    const events: JourneyEvent[] = [];
    for (const line of lines) {
      if (line.trim() === "") {
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        throw corruptError("Journey ledger contains an unparseable line");
      }
      const event = fromPersistedJourneyEvent(raw);
      if (!event.ok) {
        throw corruptError("Journey ledger contains an invalid event");
      }
      events.push(event.value);
    }
    return events;
  }

  private async readRawLines(): Promise<string[]> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return [];
      }
      throw createKestrelError({
        code: "DM_STATE_READ_FAILED",
        category: "TRANSIENT",
        userMessage: "Failed to read the journey ledger",
        suggestedActions: ["Retry the operation"],
        retryability: "RETRYABLE",
        recoveryStrategy: "RETRY",
        severity: "ERROR",
        cause: error,
      });
    }
    return content.split("\n");
  }
}
