import type { RepositoryIdentity } from "../domain/challenge/repository-identity.js";
import type { MissionStatus } from "../domain/mission/mission-status.js";
import type { MissionId } from "../domain/shared/identifiers.js";
import type { IsoDateTime } from "../domain/shared/time.js";

export interface MissionIndexEntry {
  readonly missionId: MissionId;
  readonly sidecarPath: string;
  readonly repository: RepositoryIdentity;
  readonly status: MissionStatus;
  readonly updatedAt: IsoDateTime;
}

export interface MissionIndex {
  readonly entries: readonly MissionIndexEntry[];
}

export interface MissionIndexStore {
  get(): Promise<{ index: MissionIndex; version: number }>;
  save(
    index: MissionIndex,
    expectedVersion: number,
  ): Promise<{ index: MissionIndex; version: number }>;
}
