import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { createKestrelError } from "../../application/errors/kestrel-error.js";
import type { RepositoryIdentity } from "../../domain/challenge/repository-identity.js";
import type { MissionStatus } from "../../domain/mission/mission-status.js";
import type { MissionId } from "../../domain/shared/identifiers.js";
import type { IsoDateTime } from "../../domain/shared/time.js";
import type { MissionLock } from "../../ports/mission-lock.js";
import type {
  MissionIndex,
  MissionIndexEntry,
  MissionIndexStore,
} from "../../ports/mission-index-store.js";
import { readValidatedJson, writeJsonAtomically } from "../fs/atomic-json-file.js";
import { isoDateTimeSchema, repositoryIdentitySchema } from "./schemas/evidence-schema.js";

const missionIndexEntrySchema = z.object({
  missionId: z.string().min(1),
  sidecarPath: z.string().min(1),
  repository: repositoryIdentitySchema,
  status: z.enum(["ACCEPTED", "PREPARING", "IN_PROGRESS", "COMPLETED", "ABANDONED"]),
  updatedAt: isoDateTimeSchema,
});

const missionIndexFileSchema = z.object({
  schemaVersion: z.literal(1),
  stateVersion: z.number().int().min(0),
  entries: z.array(missionIndexEntrySchema),
});

type PersistedIndexEntry = z.infer<typeof missionIndexEntrySchema>;
type StoredIndexFile = z.infer<typeof missionIndexFileSchema>;

function conflictError() {
  return createKestrelError({
    code: "DM_STORE_CONFLICT",
    category: "CONFLICT",
    userMessage: "Mission index changed since it was read",
    suggestedActions: ["Reload the index and retry"],
    retryability: "NO_RETRY",
    recoveryStrategy: "USER_ACTION",
    severity: "ERROR",
  });
}

function toEntry(data: PersistedIndexEntry): MissionIndexEntry {
  return {
    missionId: data.missionId as MissionId,
    sidecarPath: data.sidecarPath,
    repository: data.repository as RepositoryIdentity,
    status: data.status as MissionStatus,
    updatedAt: data.updatedAt as IsoDateTime,
  };
}

function fromEntry(entry: MissionIndexEntry): PersistedIndexEntry {
  return {
    missionId: entry.missionId,
    sidecarPath: entry.sidecarPath,
    repository: { ...entry.repository },
    status: entry.status,
    updatedAt: entry.updatedAt,
  };
}

const INDEX_LOCK_MISSION_ID = "index" as MissionId;

export class FileSystemMissionIndexStore implements MissionIndexStore {
  constructor(
    private readonly filePath: string,
    private readonly lock?: MissionLock,
    private readonly indexLockPath?: string,
  ) {}

  async get(): Promise<{ index: MissionIndex; version: number }> {
    const envelope = await readValidatedJson(this.filePath, missionIndexFileSchema);
    if (envelope === undefined) {
      return { index: { entries: [] }, version: 0 };
    }
    return {
      index: { entries: envelope.entries.map(toEntry) },
      version: envelope.stateVersion,
    };
  }

  async save(
    index: MissionIndex,
    expectedVersion: number,
  ): Promise<{ index: MissionIndex; version: number }> {
    if (this.lock !== undefined && this.indexLockPath !== undefined) {
      return this.lock.withMissionLock(
        this.indexLockPath,
        INDEX_LOCK_MISSION_ID,
        "index-save",
        () => this.saveUnlocked(index, expectedVersion),
      );
    }
    return this.saveUnlocked(index, expectedVersion);
  }

  private async saveUnlocked(
    index: MissionIndex,
    expectedVersion: number,
  ): Promise<{ index: MissionIndex; version: number }> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const current = await readValidatedJson(this.filePath, missionIndexFileSchema);
    const currentVersion = current?.stateVersion ?? 0;
    if (currentVersion !== expectedVersion) {
      throw conflictError();
    }
    const envelope: StoredIndexFile = {
      schemaVersion: 1,
      stateVersion: expectedVersion + 1,
      entries: index.entries.map(fromEntry),
    };
    await writeJsonAtomically(this.filePath, envelope, missionIndexFileSchema);
    return { index, version: expectedVersion + 1 };
  }
}
