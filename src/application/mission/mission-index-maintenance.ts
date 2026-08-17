import type { Mission } from "../../domain/mission/mission.js";
import type { IsoDateTime } from "../../domain/shared/time.js";
import type { MissionIndexEntry, MissionIndexStore } from "../../ports/mission-index-store.js";

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
 * Upsert a mission's index entry idempotently under optimistic concurrency.
 * If the entry is already current, this is a no-op so recovery can replay it.
 */
export async function upsertMissionIndex(
  indexStore: MissionIndexStore,
  entry: MissionIndexEntry,
): Promise<void> {
  const { index, version } = await indexStore.get();
  const existingIndex = index.entries.findIndex(
    (candidate) => candidate.missionId === entry.missionId,
  );
  if (existingIndex === -1) {
    await indexStore.save({ entries: [...index.entries, entry] }, version);
    return;
  }
  const current = index.entries[existingIndex];
  if (current !== undefined && sameEntry(current, entry)) {
    return;
  }
  const entries = [...index.entries];
  entries[existingIndex] = entry;
  await indexStore.save({ entries }, version);
}
