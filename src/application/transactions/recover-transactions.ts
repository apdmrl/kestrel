import { join } from "node:path";
import type { JourneyStore } from "../../ports/journey-store.js";
import type { MissionLock } from "../../ports/mission-lock.js";
import type { MissionStore } from "../../ports/mission-store.js";
import type { TransactionJournal } from "../../ports/transaction-journal.js";

export interface RecoverDeps {
  readonly lock: MissionLock;
  readonly journal: TransactionJournal;
  readonly missionStore: MissionStore;
  readonly journeyStore: JourneyStore;
}

/**
 * Idempotently finish pending Mission/Journey transactions. Each intent is
 * replayed so that exactly one final state and one event exist.
 */
export async function recoverTransactions(deps: RecoverDeps): Promise<void> {
  const intents = await deps.journal.listPending();
  for (const intent of intents) {
    const lockPath = join(intent.sidecarPath, ".lock");
    await deps.lock.withMissionLock(lockPath, intent.missionId, "recover", async () => {
      const stored = await deps.missionStore.get(intent.sidecarPath);
      const currentVersion = stored?.version ?? 0;
      if (currentVersion !== intent.expectedStateVersion + 1) {
        await deps.missionStore.save(
          intent.sidecarPath,
          intent.targetMission,
          intent.expectedStateVersion,
        );
      }
      if (!(await deps.journeyStore.contains(intent.eventId))) {
        await deps.journeyStore.append(intent.event);
      }
      await deps.journal.remove(intent.transactionId);
    });
  }
}
