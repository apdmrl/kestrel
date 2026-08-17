import { join } from "node:path";
import type { AgentHandoffStore } from "../../ports/agent-handoff-store.js";
import type { JourneyStore } from "../../ports/journey-store.js";
import type { MissionIndexStore } from "../../ports/mission-index-store.js";
import type { MissionLock } from "../../ports/mission-lock.js";
import type { MissionStore } from "../../ports/mission-store.js";
import type { TransactionJournal } from "../../ports/transaction-journal.js";
import { missionIndexEntry, upsertMissionIndex } from "../mission/mission-index-maintenance.js";

export interface RecoverDeps {
  readonly lock: MissionLock;
  readonly journal: TransactionJournal;
  readonly missionStore: MissionStore;
  readonly journeyStore: JourneyStore;
  readonly indexStore: MissionIndexStore;
  readonly handoffStore?: AgentHandoffStore;
}

/**
 * Idempotently finish pending Mission/Journey transactions. Each intent is
 * replayed so that exactly one final state, one index entry, and one event exist.
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
      await upsertMissionIndex(
        deps.indexStore,
        missionIndexEntry(intent.targetMission, intent.sidecarPath, intent.event.occurredAt),
      );
      if (intent.handoff !== undefined) {
        await deps.handoffStore?.save(intent.handoff, intent.sidecarPath);
      }
      if (!(await deps.journeyStore.contains(intent.eventId))) {
        await deps.journeyStore.append(intent.event);
      }
      await deps.journal.remove(intent.transactionId);
    });
  }
}
