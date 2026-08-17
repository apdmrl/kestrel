import { createJourneyEvent } from "../../domain/journey/journey-event.js";
import { createPullRequestEvidence } from "../../domain/evidence/evidence.js";
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
import { matchPullRequest } from "./pr-matcher.js";
import { commitMissionChange } from "../transactions/commit-mission-change.js";

export interface VerifySubmissionDeps {
  readonly lock: MissionLock;
  readonly journal: TransactionJournal;
  readonly missionStore: MissionStore;
  readonly journeyStore: JourneyStore;
  readonly gateway: GitHubGateway;
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
}

export interface VerifySubmissionInput {
  readonly mission: Mission;
  readonly sidecarPath: string;
  readonly lockPath: string;
  readonly expectedStateVersion: number;
  readonly token: string;
  readonly expectedAuthor: string;
  readonly prNumber: number;
  readonly missionCommits: readonly string[];
}

export type VerifySubmissionResult =
  | { readonly kind: "submitted"; readonly mission: Mission }
  | { readonly kind: "not-submitted"; readonly reasons: readonly string[] };

function missionRepository(mission: Mission): RepositoryIdentity {
  return mission.challengeSnapshot.repository;
}

/** Verify a GitHub pull request as evidence of the mission's submission. */
export async function verifySubmission(
  deps: VerifySubmissionDeps,
  input: VerifySubmissionInput,
): Promise<VerifySubmissionResult> {
  const repository = missionRepository(input.mission);
  const pr = await deps.gateway.getPullRequest(repository, input.prNumber, input.token);

  const existing = input.mission.submittedPullRequest;
  if (existing !== undefined && existing.number === pr.number) {
    return { kind: "submitted", mission: input.mission };
  }

  const match = matchPullRequest({
    repository,
    prRepository: pr.repository,
    expectedAuthor: input.expectedAuthor,
    prAuthor: pr.author,
    missionCommits: input.missionCommits,
    prCommits: pr.commits,
    ...(input.mission.branch !== undefined ? { missionBranch: input.mission.branch } : {}),
  });
  if (match.kind !== "match") {
    return { kind: "not-submitted", reasons: match.reasons };
  }

  const evidence = createPullRequestEvidence({
    id: deps.idGenerator.newEvidenceId(),
    missionId: input.mission.id,
    observedAt: deps.clock.now(),
    number: pr.number,
    url: pr.url,
    repository: pr.repository,
    author: pr.author,
    commits: pr.commits,
    state: pr.state,
  });
  if (!evidence.ok) {
    throw createKestrelError({
      code: "DM_STATE_CORRUPTED",
      category: "FATAL",
      userMessage: "Failed to build submission evidence",
      suggestedActions: [],
      retryability: "NO_RETRY",
      recoveryStrategy: "MANUAL_INTERVENTION",
      severity: "FATAL",
    });
  }
  const submitted = input.mission.recordSubmitted(evidence.value);
  if (!submitted.ok) {
    throw createKestrelError({
      code: "DM_VERIFICATION_CONFLICT",
      category: "CONFLICT",
      userMessage: submitted.error.message,
      suggestedActions: ["Review existing submission evidence"],
      retryability: "NO_RETRY",
      recoveryStrategy: "USER_ACTION",
      severity: "ERROR",
    });
  }

  const event = createJourneyEvent({
    eventId: deps.idGenerator.newEventId(),
    missionId: input.mission.id,
    type: "PullRequestSubmitted",
    occurredAt: deps.clock.now(),
    payload: { pullRequestNumber: pr.number, url: pr.url },
  });
  if (!event.ok) {
    throw createKestrelError({
      code: "DM_STATE_CORRUPTED",
      category: "FATAL",
      userMessage: "Failed to build the submission event",
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
      operation: "verify-submission",
      expectedStateVersion: input.expectedStateVersion,
      targetMission: submitted.value,
      event: event.value,
    },
  );
  return { kind: "submitted", mission: submitted.value };
}
