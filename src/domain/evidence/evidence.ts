import type { MissionId } from "../shared/identifiers.js";
import type { DomainResult } from "../shared/result.js";
import { err, ok } from "../shared/result.js";
import type { IsoDateTime } from "../shared/time.js";
import type { Brand } from "../shared/brand.js";
import type { RepositoryIdentity } from "../challenge/repository-identity.js";

export type EvidenceId = Brand<string, "EvidenceId">;

export interface EvidenceBase {
  readonly id: EvidenceId;
  readonly missionId: MissionId;
  readonly provider: "github";
  readonly observedAt: IsoDateTime;
}

export interface LocalChangeEvidence extends EvidenceBase {
  readonly kind: "LOCAL_CHANGE";
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly commitsCreated: readonly string[];
  readonly filesChanged: readonly string[];
  readonly insertions: number;
  readonly deletions: number;
  readonly workingTreeState: "CLEAN" | "DIRTY";
}

export interface CommitEvidence extends EvidenceBase {
  readonly kind: "COMMIT";
  readonly sha: string;
  readonly message: string;
  readonly author: string;
  readonly committedAt: IsoDateTime;
}

export interface PullRequestEvidence extends EvidenceBase {
  readonly kind: "PULL_REQUEST";
  readonly number: number;
  readonly url: string;
  readonly repository: RepositoryIdentity;
  readonly author: string;
  readonly commits: readonly string[];
  readonly state: "OPEN" | "MERGED" | "CLOSED";
}

export interface IssueLinkEvidence extends EvidenceBase {
  readonly kind: "ISSUE_LINK";
  readonly issueNumber: number;
  readonly repository: RepositoryIdentity;
  readonly relationship: "CLOSING_KEYWORD" | "CROSS_REFERENCE" | "PROVIDER_VERIFIED";
}

export interface MergeEvidence extends EvidenceBase {
  readonly kind: "MERGE";
  readonly pullRequestNumber: number;
  readonly repository: RepositoryIdentity;
  readonly mergeSha: string;
  readonly mergedAt: IsoDateTime;
}

export type Evidence =
  LocalChangeEvidence | CommitEvidence | PullRequestEvidence | IssueLinkEvidence | MergeEvidence;

function nonEmpty(value: string, label: string): DomainResult<never> | null {
  return value.trim().length === 0
    ? err("DM_INVALID_EVIDENCE", `${label} must not be empty`)
    : null;
}

export interface CreateLocalChangeEvidenceInput {
  readonly id: EvidenceId;
  readonly missionId: MissionId;
  readonly observedAt: IsoDateTime;
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly commitsCreated: readonly string[];
  readonly filesChanged: readonly string[];
  readonly insertions: number;
  readonly deletions: number;
  readonly workingTreeState: "CLEAN" | "DIRTY";
}

export function createLocalChangeEvidence(
  input: CreateLocalChangeEvidenceInput,
): DomainResult<LocalChangeEvidence> {
  for (const [label, value] of [
    ["baseCommit", input.baseCommit],
    ["headCommit", input.headCommit],
  ] as const) {
    const problem = nonEmpty(value, label);
    if (problem) {
      return problem;
    }
  }
  return ok({
    id: input.id,
    missionId: input.missionId,
    provider: "github",
    observedAt: input.observedAt,
    kind: "LOCAL_CHANGE",
    baseCommit: input.baseCommit,
    headCommit: input.headCommit,
    commitsCreated: [...input.commitsCreated],
    filesChanged: [...input.filesChanged],
    insertions: input.insertions,
    deletions: input.deletions,
    workingTreeState: input.workingTreeState,
  });
}

export interface CreateCommitEvidenceInput {
  readonly id: EvidenceId;
  readonly missionId: MissionId;
  readonly observedAt: IsoDateTime;
  readonly sha: string;
  readonly message: string;
  readonly author: string;
  readonly committedAt: IsoDateTime;
}

export function createCommitEvidence(
  input: CreateCommitEvidenceInput,
): DomainResult<CommitEvidence> {
  const problem = nonEmpty(input.sha, "sha");
  if (problem) {
    return problem;
  }
  return ok({
    id: input.id,
    missionId: input.missionId,
    provider: "github",
    observedAt: input.observedAt,
    kind: "COMMIT",
    sha: input.sha,
    message: input.message,
    author: input.author,
    committedAt: input.committedAt,
  });
}

export interface CreatePullRequestEvidenceInput {
  readonly id: EvidenceId;
  readonly missionId: MissionId;
  readonly observedAt: IsoDateTime;
  readonly number: number;
  readonly url: string;
  readonly repository: RepositoryIdentity;
  readonly author: string;
  readonly commits: readonly string[];
  readonly state: "OPEN" | "MERGED" | "CLOSED";
}

export function createPullRequestEvidence(
  input: CreatePullRequestEvidenceInput,
): DomainResult<PullRequestEvidence> {
  const problem = nonEmpty(input.url, "url");
  if (problem) {
    return problem;
  }
  return ok({
    id: input.id,
    missionId: input.missionId,
    provider: "github",
    observedAt: input.observedAt,
    kind: "PULL_REQUEST",
    number: input.number,
    url: input.url,
    repository: { ...input.repository },
    author: input.author,
    commits: [...input.commits],
    state: input.state,
  });
}

export interface CreateIssueLinkEvidenceInput {
  readonly id: EvidenceId;
  readonly missionId: MissionId;
  readonly observedAt: IsoDateTime;
  readonly issueNumber: number;
  readonly repository: RepositoryIdentity;
  readonly relationship: "CLOSING_KEYWORD" | "CROSS_REFERENCE" | "PROVIDER_VERIFIED";
}

export function createIssueLinkEvidence(
  input: CreateIssueLinkEvidenceInput,
): DomainResult<IssueLinkEvidence> {
  return ok({
    id: input.id,
    missionId: input.missionId,
    provider: "github",
    observedAt: input.observedAt,
    kind: "ISSUE_LINK",
    issueNumber: input.issueNumber,
    repository: { ...input.repository },
    relationship: input.relationship,
  });
}

export interface CreateMergeEvidenceInput {
  readonly id: EvidenceId;
  readonly missionId: MissionId;
  readonly observedAt: IsoDateTime;
  readonly pullRequestNumber: number;
  readonly repository: RepositoryIdentity;
  readonly mergeSha: string;
  readonly mergedAt: IsoDateTime;
}

export function createMergeEvidence(input: CreateMergeEvidenceInput): DomainResult<MergeEvidence> {
  const problem = nonEmpty(input.mergeSha, "mergeSha");
  if (problem) {
    return problem;
  }
  if (!Number.isInteger(input.pullRequestNumber) || input.pullRequestNumber <= 0) {
    return err("DM_INVALID_EVIDENCE", "pullRequestNumber must be a positive integer");
  }
  return ok({
    id: input.id,
    missionId: input.missionId,
    provider: "github",
    observedAt: input.observedAt,
    kind: "MERGE",
    pullRequestNumber: input.pullRequestNumber,
    repository: { ...input.repository },
    mergeSha: input.mergeSha,
    mergedAt: input.mergedAt,
  });
}
