import type { Mission } from "../domain/mission/mission.js";

export interface StoredMission {
  readonly mission: Mission;
  readonly version: number;
}

/** Reads and writes a single mission's state file in its sidecar directory. */
export interface MissionStore {
  get(sidecarPath: string): Promise<StoredMission | undefined>;
  save(sidecarPath: string, mission: Mission, expectedVersion: number): Promise<StoredMission>;
}
