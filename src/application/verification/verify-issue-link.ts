import { createJourneyEvent } from "../../domain/journey/journey-event.js";
import { createIssueLinkEvidence } from "../../domain/evidence/evidence.js";
import type { Mission } from "../../domain/mission/mission.js";
import type { RepositoryIdentity } from "../../domain/challenge/repository-identity.js";
import type { Clock } from "../../ports/clock.js";
import type { GitHubGateway } from "../../ports/github-gateway.js";
import type { IdGenerator } from "../../ports/id-generator.js";
import type { JourneyStore } from "../../ports/journey-store.js";
import type { MissionIndexStore } from "../../ports/mission-index-store.js";
import type { MissionLock } from "../../ports/mission-lock.js";
import type { MissionStore } from "../../ports/mission-store.js";
import type { TransactionJournal } from "../../ports/transaction-journal.js";
import { createKestrelError } from "../errors/kestrel-error.js";
import { commitMissionChange } from "../transactions/commit-mission-change.js";

export interface VerifyIssueLinkDeps {
  readonly lock: MissionLock;
  readonly journal: TransactionJournal;
  readonly missionStore: MissionStore;
  readonly journeyStore: JourneyStore;
  readonly indexStore: MissionIndexStore;
  readonly gateway: GitHubGateway;
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
}

export interface VerifyIssueLinkInput {
  readonly mission: Mission;
  readonly sidecarPath: string;
  readonly lockPath: string;
  readonly expectedStateVersion: number;
  readonly token: string;
  readonly prNumber: number;
  readonly signal?: AbortSignal;
}

export type VerifyIssueLinkResult =
  { readonly kind: "linked"; readonly mission: Mission } | { readonly kind: "not-linked" };

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw createKestrelError({
      code: "DM_PROCESS_CANCELLED",
      category: "USER_ACTION_REQUIRED",
      userMessage: "Operation cancelled",
      suggestedActions: ["Run the command again when ready"],
      retryability: "NO_RETRY",
      recoveryStrategy: "USER_ACTION",
      severity: "INFO",
    });
  }
}

function missionRepository(mission: Mission): RepositoryIdentity {
  return mission.challengeSnapshot.repository;
}

function sameRepository(a: RepositoryIdentity, b: RepositoryIdentity): boolean {
  return a.provider === b.provider && a.owner === b.owner && a.name === b.name;
}

/** Verify an optional issue relationship for a submitted pull request. */
export async function verifyIssueLink(
  deps: VerifyIssueLinkDeps,
  input: VerifyIssueLinkInput,
): Promise<VerifyIssueLinkResult> {
  const link = await deps.gateway.getIssueLinkage(
    missionRepository(input.mission),
    input.prNumber,
    input.token,
    input.signal,
  );
  throwIfAborted(input.signal);
  if (link === undefined) {
    return { kind: "not-linked" };
  }
  // Never record linkage to an unrelated issue or repository.
  if (link.issueNumber !== input.mission.challengeSnapshot.source.issueNumber) {
    return { kind: "not-linked" };
  }
  if (!sameRepository(link.repository, missionRepository(input.mission))) {
    return { kind: "not-linked" };
  }

  const existing = input.mission.issueLink;
  if (existing !== undefined && existing.issueNumber === link.issueNumber) {
    return { kind: "linked", mission: input.mission };
  }

  const evidence = createIssueLinkEvidence({
    id: deps.idGenerator.newEvidenceId(),
    missionId: input.mission.id,
    observedAt: deps.clock.now(),
    issueNumber: link.issueNumber,
    repository: missionRepository(input.mission),
    relationship: link.relationship,
  });
  if (!evidence.ok) {
    throw createKestrelError({
      code: "DM_STATE_CORRUPTED",
      category: "FATAL",
      userMessage: "Failed to build issue-link evidence",
      suggestedActions: [],
      retryability: "NO_RETRY",
      recoveryStrategy: "MANUAL_INTERVENTION",
      severity: "FATAL",
    });
  }
  const linked = input.mission.recordIssueLink(evidence.value);
  if (!linked.ok) {
    throw createKestrelError({
      code: "DM_VERIFICATION_CONFLICT",
      category: "CONFLICT",
      userMessage: linked.error.message,
      suggestedActions: ["Review existing issue-link evidence"],
      retryability: "NO_RETRY",
      recoveryStrategy: "USER_ACTION",
      severity: "ERROR",
    });
  }
  const event = createJourneyEvent({
    eventId: deps.idGenerator.newEventId(),
    missionId: input.mission.id,
    type: "IssueLinkVerified",
    occurredAt: deps.clock.now(),
    payload: { issueNumber: link.issueNumber },
  });
  if (!event.ok) {
    throw createKestrelError({
      code: "DM_STATE_CORRUPTED",
      category: "FATAL",
      userMessage: "Failed to build the issue-link event",
      suggestedActions: [],
      retryability: "NO_RETRY",
      recoveryStrategy: "MANUAL_INTERVENTION",
      severity: "FATAL",
    });
  }
  throwIfAborted(input.signal); // Cancel immediately before the final commit.
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
      missionId: input.mission.id,
      sidecarPath: input.sidecarPath,
      operation: "verify-link",
      expectedStateVersion: input.expectedStateVersion,
      targetMission: linked.value,
      event: event.value,
    },
  );
  return { kind: "linked", mission: linked.value };
}
