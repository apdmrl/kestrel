import type { Mission } from "../domain/mission/mission.js";
import { PREPARATION_CHECKPOINTS } from "../domain/mission/preparation-checkpoint.js";

/** Record every preparation checkpoint in order (test fixture helper). */
export function recordAllPreparationCheckpoints(mission: Mission): Mission {
  let current = mission;
  for (const checkpoint of PREPARATION_CHECKPOINTS) {
    const result = current.recordPreparationCheckpoint(checkpoint, {});
    current = (result as { ok: true; value: Mission }).value;
  }
  return current;
}
