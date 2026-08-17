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
}

/**
 * Persist a Mission state change and its Journey event as one recoverable unit
 * WITHOUT acquiring the mission lock. The caller must already hold the lock.
 * This is the single internal mutation primitive for nested workflows such as
 * mission preparation, which acquires the lock exactly once.
 */
export async function commitMissionChangeUnderLock(
  deps: CommitMissionDeps,
  change: MissionChange,
): Promise<void> {
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
    await deps.journeyStore.append(change.event);
    await deps.journal.advancePhase(change.transactionId, "EVENT_APPENDED");
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
