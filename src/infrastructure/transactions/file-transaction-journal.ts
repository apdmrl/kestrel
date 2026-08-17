import { mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { createKestrelError } from "../../application/errors/kestrel-error.js";
import type { EventId, MissionId, TransactionId } from "../../domain/shared/identifiers.js";
import type {
  NewTransactionIntent,
  TransactionIntent,
  TransactionJournal,
  TransactionPhase,
} from "../../ports/transaction-journal.js";
import { readValidatedJson, writeJsonAtomically } from "../fs/atomic-json-file.js";
import {
  fromPersistedJourneyEvent,
  toPersistedJourneyEvent,
} from "../persistence/mappers/journey-event-mapper.js";
import { fromPersistedMission, toPersistedMission } from "../persistence/mappers/mission-mapper.js";
import { journeyEventSchema } from "../persistence/schemas/journey-event-schema.js";
import { missionSchema } from "../persistence/schemas/mission-schema.js";

const transactionIntentSchema = z.object({
  schemaVersion: z.literal(1),
  transactionId: z.string().min(1),
  eventId: z.string().min(1),
  missionId: z.string().min(1),
  expectedStateVersion: z.number().int().min(0),
  targetMission: missionSchema,
  event: journeyEventSchema,
  phase: z.enum(["PREPARED", "STATE_WRITTEN", "EVENT_APPENDED"]),
});

type PersistedIntent = z.infer<typeof transactionIntentSchema>;

const PHASE_ORDER: Record<TransactionPhase, number> = {
  PREPARED: 0,
  STATE_WRITTEN: 1,
  EVENT_APPENDED: 2,
};

function notFoundError(transactionId: TransactionId) {
  return createKestrelError({
    code: "DM_STATE_CORRUPTED",
    category: "RECOVERABLE_STATE",
    userMessage: "Transaction intent not found",
    suggestedActions: ["Restart recovery, or remove the orphaned intent"],
    retryability: "NO_RETRY",
    recoveryStrategy: "MANUAL_INTERVENTION",
    severity: "ERROR",
    debugContext: { transactionId },
  });
}

function illegalPhaseError(from: TransactionPhase, to: TransactionPhase) {
  return createKestrelError({
    code: "DM_STATE_CORRUPTED",
    category: "RECOVERABLE_STATE",
    userMessage: "Illegal transaction phase transition",
    suggestedActions: ["Restart recovery"],
    retryability: "NO_RETRY",
    recoveryStrategy: "MANUAL_INTERVENTION",
    severity: "ERROR",
    debugContext: { from, to },
  });
}

function corruptIntentError(transactionId: TransactionId) {
  return createKestrelError({
    code: "DM_STATE_CORRUPTED",
    category: "RECOVERABLE_STATE",
    userMessage: "Transaction intent is invalid",
    suggestedActions: ["Remove or repair the corrupt intent file"],
    retryability: "NO_RETRY",
    recoveryStrategy: "MANUAL_INTERVENTION",
    severity: "ERROR",
    debugContext: { transactionId },
  });
}

export class FileTransactionJournal implements TransactionJournal {
  constructor(private readonly directory: string) {}

  private pathFor(transactionId: TransactionId): string {
    return join(this.directory, transactionId + ".json");
  }

  async create(intent: NewTransactionIntent): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const persisted: PersistedIntent = {
      schemaVersion: 1,
      transactionId: intent.transactionId,
      eventId: intent.eventId,
      missionId: intent.missionId,
      expectedStateVersion: intent.expectedStateVersion,
      targetMission: toPersistedMission(intent.targetMission),
      event: toPersistedJourneyEvent(intent.event),
      phase: "PREPARED",
    };
    await writeJsonAtomically(
      this.pathFor(intent.transactionId),
      persisted,
      transactionIntentSchema,
    );
  }

  async advancePhase(transactionId: TransactionId, phase: TransactionPhase): Promise<void> {
    const path = this.pathFor(transactionId);
    const persisted = await readValidatedJson(path, transactionIntentSchema);
    if (persisted === undefined) {
      throw notFoundError(transactionId);
    }
    const currentOrder = PHASE_ORDER[persisted.phase];
    const targetOrder = PHASE_ORDER[phase];
    if (targetOrder < currentOrder) {
      throw illegalPhaseError(persisted.phase, phase);
    }
    if (targetOrder === currentOrder) {
      return;
    }
    if (targetOrder > currentOrder + 1) {
      throw illegalPhaseError(persisted.phase, phase);
    }
    const updated: PersistedIntent = { ...persisted, phase };
    await writeJsonAtomically(path, updated, transactionIntentSchema);
  }

  async get(transactionId: TransactionId): Promise<TransactionIntent | undefined> {
    const persisted = await readValidatedJson(this.pathFor(transactionId), transactionIntentSchema);
    if (persisted === undefined) {
      return undefined;
    }
    return this.toDomain(transactionId, persisted);
  }

  async listPending(): Promise<TransactionIntent[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const intents: TransactionIntent[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const transactionId = name.slice(0, -".json".length) as TransactionId;
      const persisted = await readValidatedJson(
        join(this.directory, name),
        transactionIntentSchema,
      );
      if (persisted === undefined) {
        continue;
      }
      intents.push(this.toDomain(transactionId, persisted));
    }
    return intents;
  }

  async remove(transactionId: TransactionId): Promise<void> {
    await unlink(this.pathFor(transactionId)).catch((error: unknown) => {
      if ((error as { code?: string }).code !== "ENOENT") {
        throw error;
      }
    });
  }

  private toDomain(transactionId: TransactionId, persisted: PersistedIntent): TransactionIntent {
    const mission = fromPersistedMission(persisted.targetMission);
    if (!mission.ok) {
      throw corruptIntentError(transactionId);
    }
    const event = fromPersistedJourneyEvent(persisted.event);
    if (!event.ok) {
      throw corruptIntentError(transactionId);
    }
    return {
      transactionId,
      eventId: persisted.eventId as EventId,
      missionId: persisted.missionId as MissionId,
      expectedStateVersion: persisted.expectedStateVersion,
      targetMission: mission.value,
      event: event.value,
      phase: persisted.phase,
    };
  }
}
