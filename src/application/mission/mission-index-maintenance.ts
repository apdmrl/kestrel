import type { Mission } from "../../domain/mission/mission.js";
import type { IsoDateTime } from "../../domain/shared/time.js";
import type {
  MissionIndex,
  MissionIndexEntry,
  MissionIndexStore,
} from "../../ports/mission-index-store.js";
import { createKestrelError, isKestrelError } from "../errors/kestrel-error.js";

/** Build the index entry that must accompany a Mission state change. */
export function missionIndexEntry(
  mission: Mission,
  sidecarPath: string,
  updatedAt: IsoDateTime,
): MissionIndexEntry {
  return {
    missionId: mission.id,
    sidecarPath,
    repository: mission.challengeSnapshot.repository,
    status: mission.status,
    updatedAt,
  };
}

function sameEntry(a: MissionIndexEntry, b: MissionIndexEntry): boolean {
  return (
    a.missionId === b.missionId &&
    a.sidecarPath === b.sidecarPath &&
    a.repository.provider === b.repository.provider &&
    a.repository.owner === b.repository.owner &&
    a.repository.name === b.repository.name &&
    a.status === b.status &&
    a.updatedAt === b.updatedAt
  );
}

/**
 * Compute the merged index for an entry, or undefined when it is already current.
 */
function mergedIndex(index: MissionIndex, entry: MissionIndexEntry): MissionIndex | undefined {
  const existingIndex = index.entries.findIndex(
    (candidate) => candidate.missionId === entry.missionId,
  );
  if (existingIndex === -1) {
    return { entries: [...index.entries, entry] };
  }
  const current = index.entries[existingIndex];
  if (current !== undefined && sameEntry(current, entry)) {
    return undefined;
  }
  const entries = [...index.entries];
  entries[existingIndex] = entry;
  return { entries };
}

/**
 * Upsert a mission's index entry idempotently under optimistic concurrency.
 * A lost-update conflict is retried by re-reading and re-merging, so concurrent
 * writers on different missions converge instead of overwriting one another.
 * The caller's store is responsible for atomic check-then-write serialization
 * across processes.
 */
function retriesExhaustedError() {
  return createKestrelError({
    code: "DM_STORE_CONFLICT",
    category: "CONFLICT",
    userMessage: "Mission index remained contended after retrying",
    suggestedActions: ["Retry the operation"],
    retryability: "RETRYABLE",
    recoveryStrategy: "RETRY",
    severity: "ERROR",
  });
}

/** Yield to the event loop so a concurrent lock holder can finish. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function upsertMissionIndex(
  indexStore: MissionIndexStore,
  entry: MissionIndexEntry,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { index, version } = await indexStore.get();
    const merged = mergedIndex(index, entry);
    if (merged === undefined) {
      return;
    }
    try {
      await indexStore.save(merged, version);
      return;
    } catch (error) {
      if (isKestrelError(error) && error.code === "DM_STORE_CONFLICT") {
        continue;
      }
      if (isKestrelError(error) && error.code === "DM_MISSION_LOCKED") {
        await yieldToEventLoop();
        continue;
      }
      throw error;
    }
  }
  throw retriesExhaustedError();
}
