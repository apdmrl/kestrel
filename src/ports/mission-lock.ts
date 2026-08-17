import type { MissionId } from "../domain/shared/identifiers.js";

/** Mission-level single-writer lock. The caller supplies the lock file path. */
export interface MissionLock {
  withMissionLock<T>(
    lockPath: string,
    missionId: MissionId,
    operation: string,
    action: () => Promise<T>,
  ): Promise<T>;
  breakStaleLock(lockPath: string): Promise<void>;
}
