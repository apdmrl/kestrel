import type { PreparationCheckpoint } from "../../domain/mission/preparation-checkpoint.js";
import type { MissionId } from "../../domain/shared/identifiers.js";

/**
 * A durable point at which a real crash can be reproduced deterministically:
 * immediately after a preparation checkpoint or a transaction phase has been
 * durably persisted.
 */
export type RecoveryBoundary =
  | `preparation:${PreparationCheckpoint}:persisted`
  | `transaction:${"PREPARED" | "STATE_WRITTEN" | "EVENT_APPENDED"}:persisted`;

/** Internal recovery test barrier. Production defaults to a no-op. */
export interface RecoveryBarrier {
  reach(boundary: RecoveryBoundary, missionId: MissionId): Promise<void>;
}

const noopBarrier: RecoveryBarrier = {
  reach: async () => undefined,
};

let current: RecoveryBarrier = noopBarrier;

/**
 * Set the active barrier (bootstrap, test-only composition). Never called with a
 * real barrier in normal production composition.
 */
export function setRecoveryBarrier(barrier: RecoveryBarrier): void {
  current = barrier;
}

export function resetRecoveryBarrier(): void {
  current = noopBarrier;
}

/** Returns the active barrier; callers must await `reach` at each boundary. */
export function getRecoveryBarrier(): RecoveryBarrier {
  return current;
}
