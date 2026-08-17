import { createJourneyEvent } from "../../domain/journey/journey-event.js";
import { Mission } from "../../domain/mission/mission.js";
import type { DeveloperMode } from "../../domain/preferences/preferences.js";
import type { Recommendation } from "../../domain/recommendation/recommendation.js";
import { snapshotRecommendation } from "../../domain/recommendation/recommendation.js";
import type { EventId } from "../../domain/shared/identifiers.js";
import type { DomainResult } from "../../domain/shared/result.js";
import type { Clock } from "../../ports/clock.js";
import type { IdGenerator } from "../../ports/id-generator.js";
import type { JourneyStore } from "../../ports/journey-store.js";
import type { MissionIndexStore } from "../../ports/mission-index-store.js";
import type { MissionLock } from "../../ports/mission-lock.js";
import type { MissionStore } from "../../ports/mission-store.js";
import type { TransactionJournal } from "../../ports/transaction-journal.js";
import type { WorkspaceManager } from "../../ports/workspace-manager.js";
import { createKestrelError } from "../errors/kestrel-error.js";
import { commitMissionChange } from "../transactions/commit-mission-change.js";

export interface AcceptMissionDeps {
  readonly lock: MissionLock;
  readonly journal: TransactionJournal;
  readonly missionStore: MissionStore;
  readonly journeyStore: JourneyStore;
  readonly indexStore: MissionIndexStore;
  readonly workspaceManager: WorkspaceManager;
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
}

export interface AcceptMissionInput {
  readonly recommendation: Recommendation;
  readonly mode: DeveloperMode;
  readonly workspaceRoot: string;
  readonly idempotencyKey?: EventId;
}

function must<T>(result: DomainResult<T>): T {
  if (result.ok) {
    return result.value;
  }
  throw createKestrelError({
    code: "DM_STATE_CORRUPTED",
    category: "FATAL",
    userMessage: "Internal error: domain construction failed for valid input",
    suggestedActions: [],
    retryability: "NO_RETRY",
    recoveryStrategy: "MANUAL_INTERVENTION",
    severity: "FATAL",
    debugContext: { error: result.error },
  });
}

/** Persist an ACCEPTED Mission plus exactly one MissionAccepted event transactionally. */
export async function acceptMission(
  deps: AcceptMissionDeps,
  input: AcceptMissionInput,
): Promise<Mission> {
  const missionId = deps.idGenerator.newMissionId();
  const eventId = input.idempotencyKey ?? deps.idGenerator.newEventId();
  const transactionId = deps.idGenerator.newTransactionId();
  const acceptedAt = deps.clock.now();

  const mission = must(
    Mission.accept({
      id: missionId,
      challengeSnapshot: input.recommendation.challenge,
      recommendationSnapshot: snapshotRecommendation(input.recommendation),
      mode: input.mode,
      workspaceRoot: input.workspaceRoot,
      acceptedAt,
    }),
  );

  const plan = deps.workspaceManager.planWorkspace(
    input.workspaceRoot,
    missionId,
    input.recommendation.challenge.repository,
    input.recommendation.challenge.source.issueNumber,
  );

  const event = must(
    createJourneyEvent({
      eventId,
      missionId,
      type: "MissionAccepted",
      occurredAt: acceptedAt,
      payload: {
        mode: input.mode,
        repository: input.recommendation.challenge.repository,
      },
    }),
  );

  await commitMissionChange(
    {
      lock: deps.lock,
      journal: deps.journal,
      missionStore: deps.missionStore,
      journeyStore: deps.journeyStore,
      indexStore: deps.indexStore,
    },
    {
      transactionId,
      missionId,
      sidecarPath: plan.sidecarPath,
      operation: "accept",
      expectedStateVersion: 0,
      targetMission: mission,
      event,
    },
  );

  return mission;
}
