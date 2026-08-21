import { createJourneyEvent } from "../../domain/journey/journey-event.js";
import { createPullRequestEvidence } from "../../domain/evidence/evidence.js";
import type { Mission } from "../../domain/mission/mission.js";
import type { RepositoryIdentity } from "../../domain/challenge/repository-identity.js";
import type { Clock } from "../../ports/clock.js";
import type { GitClient } from "../../ports/git-client.js";
import type { GitHubGateway } from "../../ports/github-gateway.js";
import type { IdGenerator } from "../../ports/id-generator.js";
import type { JourneyStore } from "../../ports/journey-store.js";
import type { MissionIndexStore } from "../../ports/mission-index-store.js";
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
  readonly indexStore: MissionIndexStore;
  readonly gateway: GitHubGateway;
  readonly git: GitClient;
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
}

export interface VerifySubmissionInput {
  readonly mission: Mission;
  readonly sidecarPath: string;
  readonly lockPath: string;
  readonly expectedStateVersion: number;
  readonly token: string;
  readonly prNumber: number;
  readonly signal?: AbortSignal;
}

export type VerifySubmissionResult =
  | { readonly kind: "submitted"; readonly mission: Mission }
  | { readonly kind: "not-submitted"; readonly reasons: readonly string[] };

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

/** Derive the authenticated author from the gateway, never from caller input. */
async function authenticatedAuthor(
  deps: VerifySubmissionDeps,
  token: string,
  signal?: AbortSignal,
): Promise<string> {
  const viewer = await deps.gateway.getViewer(token, signal);
  return viewer.login;
}

/** Derive mission commits from the verified local repository, never from caller input. */
async function missionCommits(
  deps: VerifySubmissionDeps,
  mission: Mission,
): Promise<readonly string[]> {
  const base = mission.immutableBaseCommit;
  if (base === undefined) {
    return [];
  }
  const changes = await deps.git.collectChangesSince(base);
  return changes.commits;
}

/** Verify a GitHub pull request as evidence of the mission's submission. */
export async function verifySubmission(
  deps: VerifySubmissionDeps,
  input: VerifySubmissionInput,
): Promise<VerifySubmissionResult> {
  const repository = missionRepository(input.mission);
  const author = await authenticatedAuthor(deps, input.token, input.signal);
  throwIfAborted(input.signal);
  const commits = await missionCommits(deps, input.mission);
  const pr = await deps.gateway.getPullRequest(
    repository,
    input.prNumber,
    input.token,
    input.signal,
  );
  throwIfAborted(input.signal);

  const existing = input.mission.submittedPullRequest;
  if (existing !== undefined && existing.number === pr.number) {
    return { kind: "submitted", mission: input.mission };
  }

  const match = matchPullRequest({
    repository,
    prRepository: pr.repository,
    expectedAuthor: author,
    prAuthor: pr.author,
    missionCommits: commits,
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
      operation: "verify-submission",
      expectedStateVersion: input.expectedStateVersion,
      targetMission: submitted.value,
      event: event.value,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    },
  );
  return { kind: "submitted", mission: submitted.value };
}
