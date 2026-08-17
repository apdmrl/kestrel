import { createJourneyEvent } from "../../domain/journey/journey-event.js";
import { createLocalChangeEvidence } from "../../domain/evidence/evidence.js";
import type { Mission } from "../../domain/mission/mission.js";
import { policyFor } from "../../domain/policy/policies.js";
import type { RepositoryIdentity } from "../../domain/challenge/repository-identity.js";
import type { Clock } from "../../ports/clock.js";
import type { GitClient } from "../../ports/git-client.js";
import type { IdGenerator } from "../../ports/id-generator.js";
import type { JourneyStore } from "../../ports/journey-store.js";
import type { MissionIndexStore } from "../../ports/mission-index-store.js";
import type { MissionLock } from "../../ports/mission-lock.js";
import type { MissionStore } from "../../ports/mission-store.js";
import type { TransactionJournal } from "../../ports/transaction-journal.js";
import { createKestrelError } from "../errors/kestrel-error.js";
import { collectLocalEvidence } from "../evidence/collect-local-evidence.js";
import { commitMissionChange } from "../transactions/commit-mission-change.js";

export interface CompleteMissionDeps {
  readonly lock: MissionLock;
  readonly journal: TransactionJournal;
  readonly missionStore: MissionStore;
  readonly journeyStore: JourneyStore;
  readonly indexStore: MissionIndexStore;
  readonly git: GitClient;
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
}

export interface CompleteMissionInput {
  readonly mission: Mission;
  readonly sidecarPath: string;
  readonly lockPath: string;
  readonly expectedStateVersion: number;
}

function evidenceBlockedError(reasons: readonly string[]) {
  return createKestrelError({
    code: "DM_EVIDENCE_BLOCKED",
    category: "INVALID_INPUT",
    userMessage: "Completion evidence did not meet the mission policy",
    suggestedActions: reasons.length > 0 ? [...reasons] : ["Make local changes and retry"],
    retryability: "NO_RETRY",
    recoveryStrategy: "USER_ACTION",
    severity: "WARNING",
  });
}

/** Collect evidence, apply the policy decision, and complete the mission transactionally. */
export async function completeMission(
  deps: CompleteMissionDeps,
  input: CompleteMissionInput,
): Promise<Mission> {
  const mission = input.mission;
  const repository: RepositoryIdentity = mission.challengeSnapshot.repository;
  const baseSha = mission.immutableBaseCommit;
  if (baseSha === undefined) {
    throw evidenceBlockedError(["the mission has no base commit"]);
  }

  const evidence = await collectLocalEvidence(deps, { repository, baseSha });
  const policy = policyFor(mission.challengeSnapshot.type);
  const decision = policy.evaluateEvidence({
    commitCount: evidence.commits.length,
    filesChanged: evidence.filesChanged,
    // Untracked-only changes never count as tracked engineering evidence.
    hasTrackedChanges: evidence.commits.length > 0 || evidence.filesChanged.length > 0,
  });
  if (!decision.accepted) {
    throw evidenceBlockedError(decision.blockingReasons);
  }

  const evidenceRecord = createLocalChangeEvidence({
    id: deps.idGenerator.newEvidenceId(),
    missionId: mission.id,
    observedAt: deps.clock.now(),
    baseCommit: baseSha,
    headCommit: evidence.headSha,
    commitsCreated: evidence.commits,
    filesChanged: evidence.filesChanged,
    insertions: evidence.insertions,
    deletions: evidence.deletions,
    workingTreeState: evidence.workingTreeState,
  });
  if (!evidenceRecord.ok) {
    throw createKestrelError({
      code: "DM_STATE_CORRUPTED",
      category: "FATAL",
      userMessage: "Failed to build completion evidence",
      suggestedActions: [],
      retryability: "NO_RETRY",
      recoveryStrategy: "MANUAL_INTERVENTION",
      severity: "FATAL",
    });
  }

  const withEvidence = mission.addEvidence(evidenceRecord.value);
  if (!withEvidence.ok) {
    throw evidenceBlockedError(["evidence already recorded with different content"]);
  }
  const completed = withEvidence.value.complete(decision);
  if (!completed.ok) {
    throw evidenceBlockedError([completed.error.message]);
  }

  const event = createJourneyEvent({
    eventId: deps.idGenerator.newEventId(),
    missionId: mission.id,
    type: "MissionCompleted",
    occurredAt: deps.clock.now(),
  });
  if (!event.ok) {
    throw createKestrelError({
      code: "DM_STATE_CORRUPTED",
      category: "FATAL",
      userMessage: "Failed to build the completion event",
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
      indexStore: deps.indexStore,
    },
    {
      transactionId: deps.idGenerator.newTransactionId(),
      missionId: mission.id,
      sidecarPath: input.sidecarPath,
      operation: "complete",
      expectedStateVersion: input.expectedStateVersion,
      targetMission: completed.value,
      event: event.value,
    },
  );

  return completed.value;
}
