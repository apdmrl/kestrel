import { createJourneyEvent } from "../../domain/journey/journey-event.js";
import { createMergeEvidence } from "../../domain/evidence/evidence.js";
import type { Mission } from "../../domain/mission/mission.js";
import type { RepositoryIdentity } from "../../domain/challenge/repository-identity.js";
import type { Clock } from "../../ports/clock.js";
import type { GitHubGateway } from "../../ports/github-gateway.js";
import type { IdGenerator } from "../../ports/id-generator.js";
import type { JourneyStore } from "../../ports/journey-store.js";
import type { MissionLock } from "../../ports/mission-lock.js";
import type { MissionStore } from "../../ports/mission-store.js";
import type { TransactionJournal } from "../../ports/transaction-journal.js";
import { createKestrelError } from "../errors/kestrel-error.js";
import { commitMissionChange } from "../transactions/commit-mission-change.js";

export interface VerifyMergeDeps {
  readonly lock: MissionLock;
  readonly journal: TransactionJournal;
  readonly missionStore: MissionStore;
  readonly journeyStore: JourneyStore;
  readonly gateway: GitHubGateway;
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
}

export interface VerifyMergeInput {
  readonly mission: Mission;
  readonly sidecarPath: string;
  readonly lockPath: string;
  readonly expectedStateVersion: number;
  readonly token: string;
  readonly prNumber: number;
}

export type VerifyMergeResult =
  { readonly kind: "merged"; readonly mission: Mission } | { readonly kind: "not-merged" };

function missionRepository(mission: Mission): RepositoryIdentity {
  return mission.challengeSnapshot.repository;
}

/** Verify an upstream merge from live GitHub evidence (never manually assignable). */
export async function verifyMerge(
  deps: VerifyMergeDeps,
  input: VerifyMergeInput,
): Promise<VerifyMergeResult> {
  const mergeInfo = await deps.gateway.getMergeInfo(
    missionRepository(input.mission),
    input.prNumber,
    input.token,
  );
  if (!mergeInfo.merged) {
    return { kind: "not-merged" };
  }
  if (input.mission.submissionVerification === "MERGED") {
    return { kind: "merged", mission: input.mission };
  }
  if (input.mission.submissionVerification !== "SUBMITTED") {
    throw createKestrelError({
      code: "DM_ILLEGAL_TRANSITION",
      category: "INVALID_INPUT",
      userMessage: "A merge requires prior verified submission evidence",
      suggestedActions: ["Verify the submission before verifying the merge"],
      retryability: "NO_RETRY",
      recoveryStrategy: "USER_ACTION",
      severity: "ERROR",
    });
  }

  const evidence = createMergeEvidence({
    id: deps.idGenerator.newEvidenceId(),
    missionId: input.mission.id,
    observedAt: deps.clock.now(),
    pullRequestNumber: input.prNumber,
    repository: missionRepository(input.mission),
    mergeSha: mergeInfo.mergeSha ?? "",
    mergedAt: mergeInfo.mergedAt ?? deps.clock.now(),
  });
  if (!evidence.ok) {
    throw createKestrelError({
      code: "DM_STATE_CORRUPTED",
      category: "FATAL",
      userMessage: "Failed to build merge evidence",
      suggestedActions: [],
      retryability: "NO_RETRY",
      recoveryStrategy: "MANUAL_INTERVENTION",
      severity: "FATAL",
    });
  }
  const merged = input.mission.recordMerged(evidence.value);
  if (!merged.ok) {
    throw createKestrelError({
      code: "DM_VERIFICATION_CONFLICT",
      category: "CONFLICT",
      userMessage: merged.error.message,
      suggestedActions: ["Review existing merge evidence"],
      retryability: "NO_RETRY",
      recoveryStrategy: "USER_ACTION",
      severity: "ERROR",
    });
  }

  const event = createJourneyEvent({
    eventId: deps.idGenerator.newEventId(),
    missionId: input.mission.id,
    type: "PullRequestMerged",
    occurredAt: deps.clock.now(),
    payload: { pullRequestNumber: input.prNumber, mergeSha: mergeInfo.mergeSha ?? "" },
  });
  if (!event.ok) {
    throw createKestrelError({
      code: "DM_STATE_CORRUPTED",
      category: "FATAL",
      userMessage: "Failed to build the merge event",
      suggestedActions: [],
      retryability: "NO_RETRY",
      recoveryStrategy: "MANUAL_INTERVENTION",
      severity: "FATAL",
    });
  }
  await commitMissionChange(
    {
      lock: deps.lock,
      journal: deps.journal,
      missionStore: deps.missionStore,
      journeyStore: deps.journeyStore,
    },
    {
      transactionId: deps.idGenerator.newTransactionId(),
      missionId: input.mission.id,
      sidecarPath: input.sidecarPath,
      operation: "verify-merge",
      expectedStateVersion: input.expectedStateVersion,
      targetMission: merged.value,
      event: event.value,
    },
  );
  return { kind: "merged", mission: merged.value };
}
