import { join } from "node:path";
import type { JourneyEvent } from "../../domain/journey/journey-event.js";
import type { Mission } from "../../domain/mission/mission.js";
import type { MissionId, TransactionId } from "../../domain/shared/identifiers.js";
import { createKestrelError, isKestrelError } from "../errors/kestrel-error.js";
import type { AgentHandoff } from "../../domain/agent/agent-handoff.js";
import type { AgentHandoffStore } from "../../ports/agent-handoff-store.js";
import type { JourneyStore } from "../../ports/journey-store.js";
import type { MissionIndexStore } from "../../ports/mission-index-store.js";
import type { MissionLock } from "../../ports/mission-lock.js";
import type { MissionStore } from "../../ports/mission-store.js";
import type { TransactionJournal } from "../../ports/transaction-journal.js";
import { missionIndexEntry, upsertMissionIndex } from "../mission/mission-index-maintenance.js";
import { getRecoveryBarrier } from "./recovery-barrier.js";

export interface CommitMissionDeps {
  readonly lock: MissionLock;
  readonly journal: TransactionJournal;
  readonly missionStore: MissionStore;
  readonly journeyStore: JourneyStore;
  readonly indexStore: MissionIndexStore;
  readonly handoffStore?: AgentHandoffStore;
}

export interface MissionChange {
  readonly transactionId: TransactionId;
  readonly missionId: MissionId;
  readonly sidecarPath: string;
  readonly operation: string;
  readonly expectedStateVersion: number;
  readonly targetMission: Mission;
  readonly event: JourneyEvent;
  readonly handoff?: AgentHandoff;
  readonly signal?: AbortSignal;
}

function cancelledError() {
  return createKestrelError({
    code: "DM_PROCESS_CANCELLED",
    category: "USER_ACTION_REQUIRED",
    userMessage: "Operation cancelled",
    suggestedActions: ["Run the command again when ready"],
    retryability: "NO_RETRY",
    recoveryStrategy: "USER_ACTION",
    severity: "INFO",
  });
}

/**
 * Transaction cancellation contract (the explicit commit point):
 *
 *   state                  | outcome
 *   -----------------------|-------------------------------------------------
 *   abort before lock      | cancellation; no transaction is created
 *   abort while waiting    | cancellation; re-checked under the lock; no intent
 *   abort after lock,      | cancellation; re-checked immediately before intent
 *     before intent        |
 *   abort at intent        | intent creation is the point of no return; the
 *     creation             | durable phases finish and the change is committed
 *   abort after state/     | finishes recovery-safe persistence; committed
 *     index/event phases   |
 *   signal pending while   | the change is committed and reported as success
 *     committing           | (never a forced exit 130 for a completed mutation)
 *
 * The explicit point of no return is journal-intent creation. Cancellation
 * observed before it aborts the mutation cleanly; cancellation observed after it
 * must not abandon a durable transaction, so the phases always run to
 * completion and produce one unambiguous committed result.
 */
export async function commitMissionChangeUnderLock(
  deps: CommitMissionDeps,
  change: MissionChange,
): Promise<void> {
  // The explicit point of no return: journal intent creation. Cancellation
  // observed here (inside the held lock, immediately before the intent) aborts
  // the mutation; anything after this line finishes recovery-safe persistence.
  if (change.signal?.aborted === true) {
    throw cancelledError();
  }
  try {
    await deps.journal.create({
      transactionId: change.transactionId,
      eventId: change.event.eventId,
      missionId: change.missionId,
      sidecarPath: change.sidecarPath,
      expectedStateVersion: change.expectedStateVersion,
      targetMission: change.targetMission,
      event: change.event,
      ...(change.handoff !== undefined ? { handoff: change.handoff } : {}),
    });
    await getRecoveryBarrier().reach("transaction:PREPARED:persisted", change.missionId);
    await deps.missionStore.save(
      change.sidecarPath,
      change.targetMission,
      change.expectedStateVersion,
    );
    await upsertMissionIndex(
      deps.indexStore,
      missionIndexEntry(change.targetMission, change.sidecarPath, change.event.occurredAt),
    );
    if (change.handoff !== undefined) {
      if (deps.handoffStore === undefined) {
        throw createKestrelError({
          code: "DM_STATE_CORRUPTED",
          category: "FATAL",
          userMessage: "No handoff store is configured for this transaction",
          suggestedActions: [],
          retryability: "NO_RETRY",
          recoveryStrategy: "MANUAL_INTERVENTION",
          severity: "FATAL",
        });
      }
      await deps.handoffStore.save(change.handoff, change.sidecarPath);
    }
    await deps.journal.advancePhase(change.transactionId, "STATE_WRITTEN");
    await getRecoveryBarrier().reach("transaction:STATE_WRITTEN:persisted", change.missionId);
    await deps.journeyStore.append(change.event);
    await deps.journal.advancePhase(change.transactionId, "EVENT_APPENDED");
    await getRecoveryBarrier().reach("transaction:EVENT_APPENDED:persisted", change.missionId);
    await deps.journal.remove(change.transactionId);
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

/**
 * Persist a Mission state change and its Journey event as one recoverable unit:
 * lock → intent → state → index → event → complete.
 */
export async function commitMissionChange(
  deps: CommitMissionDeps,
  change: MissionChange,
): Promise<void> {
  const lockPath = join(change.sidecarPath, ".lock");
  return deps.lock.withMissionLock(lockPath, change.missionId, change.operation, async () => {
    await commitMissionChangeUnderLock(deps, change);
  });
}
