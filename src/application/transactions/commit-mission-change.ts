import { join } from "node:path";
import type { JourneyEvent } from "../../domain/journey/journey-event.js";
import type { Mission } from "../../domain/mission/mission.js";
import type { MissionId, TransactionId } from "../../domain/shared/identifiers.js";
import { createKestrelError, isKestrelError } from "../errors/kestrel-error.js";
import type { JourneyStore } from "../../ports/journey-store.js";
import type { MissionLock } from "../../ports/mission-lock.js";
import type { MissionStore } from "../../ports/mission-store.js";
import type { TransactionJournal } from "../../ports/transaction-journal.js";

export interface CommitMissionDeps {
  readonly lock: MissionLock;
  readonly journal: TransactionJournal;
  readonly missionStore: MissionStore;
  readonly journeyStore: JourneyStore;
}

export interface MissionChange {
  readonly transactionId: TransactionId;
  readonly missionId: MissionId;
  readonly sidecarPath: string;
  readonly operation: string;
  readonly expectedStateVersion: number;
  readonly targetMission: Mission;
  readonly event: JourneyEvent;
}

/**
 * Persist a Mission state change and its Journey event as one recoverable unit:
 * lock → intent → state → event → complete.
 */
export async function commitMissionChange(
  deps: CommitMissionDeps,
  change: MissionChange,
): Promise<void> {
  const lockPath = join(change.sidecarPath, ".lock");
  try {
    await deps.lock.withMissionLock(lockPath, change.missionId, change.operation, async () => {
      await deps.journal.create({
        transactionId: change.transactionId,
        eventId: change.event.eventId,
        missionId: change.missionId,
        sidecarPath: change.sidecarPath,
        expectedStateVersion: change.expectedStateVersion,
        targetMission: change.targetMission,
        event: change.event,
      });
      await deps.missionStore.save(
        change.sidecarPath,
        change.targetMission,
        change.expectedStateVersion,
      );
      await deps.journal.advancePhase(change.transactionId, "STATE_WRITTEN");
      await deps.journeyStore.append(change.event);
      await deps.journal.advancePhase(change.transactionId, "EVENT_APPENDED");
      await deps.journal.remove(change.transactionId);
    });
  } catch (error) {
    if (isKestrelError(error)) {
      throw error;
    }
    throw createKestrelError({
      code: "DM_STATE_WRITE_FAILED",
      category: "RECOVERABLE_STATE",
      userMessage: "Mission change was interrupted and can be recovered",
      suggestedActions: ["Run recovery to finish the pending change"],
      retryability: "NO_RETRY",
      recoveryStrategy: "RESUME",
      severity: "ERROR",
      cause: error,
      debugContext: { transactionId: change.transactionId },
    });
  }
}
