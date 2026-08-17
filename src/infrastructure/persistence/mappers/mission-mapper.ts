import type { Challenge } from "../../../domain/challenge/challenge.js";
import { createChallenge } from "../../../domain/challenge/challenge.js";
import { createEvidenceCollection } from "../../../domain/evidence/evidence-collection.js";
import type { EvidenceCollection } from "../../../domain/evidence/evidence-collection.js";
import {
  createCommitEvidence,
  createIssueLinkEvidence,
  createLocalChangeEvidence,
  createMergeEvidence,
  createPullRequestEvidence,
  type Evidence,
  type EvidenceId,
  type IssueLinkEvidence,
  type MergeEvidence,
  type PullRequestEvidence,
} from "../../../domain/evidence/evidence.js";
import type { WorkspaceInfo } from "../../../domain/mission/mission.js";
import { Mission } from "../../../domain/mission/mission.js";
import type { RecommendationSnapshot } from "../../../domain/recommendation/recommendation.js";
import {
  createRecommendation,
  snapshotRecommendation,
} from "../../../domain/recommendation/recommendation.js";
import type { ChallengeId } from "../../../domain/shared/identifiers.js";
import type { MissionId } from "../../../domain/shared/identifiers.js";
import type { DomainResult } from "../../../domain/shared/result.js";
import { err, ok } from "../../../domain/shared/result.js";
import type { IsoDateTime } from "../../../domain/shared/time.js";
import { checkSchemaVersion } from "../schema-version.js";
import {
  missionSchema,
  type PersistedChallenge,
  type PersistedMission,
  type PersistedRecommendationSnapshot,
} from "../schemas/mission-schema.js";
import type { PersistedEvidence } from "../schemas/evidence-schema.js";

export function toPersistedMission(mission: Mission): PersistedMission {
  return {
    schemaVersion: 1,
    id: mission.id,
    challengeSnapshot: toPersistedChallenge(mission.challengeSnapshot),
    recommendationSnapshot: toPersistedRecommendation(mission.recommendationSnapshot),
    acceptanceContext: {
      mode: mission.acceptanceContext.mode,
      workspaceRoot: mission.acceptanceContext.workspaceRoot ?? null,
      acceptedAt: mission.acceptanceContext.acceptedAt,
    },
    status: mission.status,
    workspace: mission.workspace ? { ...mission.workspace } : null,
    immutableBaseCommit: mission.immutableBaseCommit ?? null,
    branch: mission.branch ?? null,
    evidence: { items: mission.evidence.items.map(toPersistedEvidence) },
    submissionVerification: mission.submissionVerification,
    submittedPullRequest: mission.submittedPullRequest
      ? {
          ...mission.submittedPullRequest,
          repository: { ...mission.submittedPullRequest.repository },
          commits: [...mission.submittedPullRequest.commits],
        }
      : null,
    mergeEvidence: mission.mergeEvidence
      ? { ...mission.mergeEvidence, repository: { ...mission.mergeEvidence.repository } }
      : null,
    issueLink: mission.issueLink
      ? { ...mission.issueLink, repository: { ...mission.issueLink.repository } }
      : null,
  };
}

function toPersistedChallenge(challenge: Challenge): PersistedChallenge {
  return {
    id: challenge.id,
    source: {
      provider: "github",
      externalId: challenge.source.externalId,
      repository: { ...challenge.source.repository },
      issueNumber: challenge.source.issueNumber,
      canonicalUrl: challenge.source.canonicalUrl,
    },
    repository: { ...challenge.repository },
    title: challenge.title,
    description: challenge.description,
    type: challenge.type,
    labels: [...challenge.labels],
    language: challenge.language ?? null,
    topics: [...challenge.topics],
    createdAt: challenge.createdAt,
    updatedAt: challenge.updatedAt,
  };
}

function toPersistedRecommendation(
  recommendation: RecommendationSnapshot,
): PersistedRecommendationSnapshot {
  return {
    challenge: toPersistedChallenge(recommendation.challenge),
    mood: recommendation.mood,
    reasons: [...recommendation.reasons],
    signalResults: recommendation.signalResults.map((result) => ({ ...result })),
    confidence: recommendation.confidence,
    evaluatedAt: recommendation.evaluatedAt,
  };
}

function toPersistedEvidence(evidence: Evidence): PersistedEvidence {
  const base = {
    id: evidence.id,
    missionId: evidence.missionId,
    provider: "github" as const,
    observedAt: evidence.observedAt,
  };
  switch (evidence.kind) {
    case "LOCAL_CHANGE":
      return {
        ...base,
        kind: "LOCAL_CHANGE",
        baseCommit: evidence.baseCommit,
        headCommit: evidence.headCommit,
        commitsCreated: [...evidence.commitsCreated],
        filesChanged: [...evidence.filesChanged],
        insertions: evidence.insertions,
        deletions: evidence.deletions,
        workingTreeState: evidence.workingTreeState,
      };
    case "COMMIT":
      return {
        ...base,
        kind: "COMMIT",
        sha: evidence.sha,
        message: evidence.message,
        author: evidence.author,
        committedAt: evidence.committedAt,
      };
    case "PULL_REQUEST":
      return {
        ...base,
        kind: "PULL_REQUEST",
        number: evidence.number,
        url: evidence.url,
        repository: { ...evidence.repository },
        author: evidence.author,
        commits: [...evidence.commits],
        state: evidence.state,
      };
    case "ISSUE_LINK":
      return {
        ...base,
        kind: "ISSUE_LINK",
        issueNumber: evidence.issueNumber,
        repository: { ...evidence.repository },
        relationship: evidence.relationship,
      };
    case "MERGE":
      return {
        ...base,
        kind: "MERGE",
        pullRequestNumber: evidence.pullRequestNumber,
        repository: { ...evidence.repository },
        mergeSha: evidence.mergeSha,
        mergedAt: evidence.mergedAt,
      };
  }
}

export function fromPersistedMission(data: unknown): DomainResult<Mission> {
  const version = checkSchemaVersion(data);
  if (!version.ok) {
    return version;
  }
  const parsed = missionSchema.safeParse(data);
  if (!parsed.success) {
    return err("DM_STATE_CORRUPTED", "mission state failed schema validation");
  }
  return reconstructMission(parsed.data);
}

function reconstructChallenge(data: PersistedChallenge): DomainResult<Challenge> {
  return createChallenge({
    id: data.id as ChallengeId,
    externalId: data.source.externalId,
    repository: { ...data.repository },
    issueNumber: data.source.issueNumber,
    canonicalUrl: data.source.canonicalUrl,
    title: data.title,
    description: data.description,
    type: data.type,
    labels: data.labels,
    ...(data.language !== null ? { language: data.language } : {}),
    topics: data.topics,
    createdAt: data.createdAt as IsoDateTime,
    updatedAt: data.updatedAt as IsoDateTime,
  });
}

function reconstructRecommendation(
  data: PersistedRecommendationSnapshot,
  challenge: Challenge,
): DomainResult<RecommendationSnapshot> {
  const recommendation = createRecommendation({
    challenge,
    mood: data.mood,
    signalResults: data.signalResults,
    confidence: data.confidence,
    evaluatedAt: data.evaluatedAt as IsoDateTime,
  });
  if (!recommendation.ok) {
    return recommendation;
  }
  return ok(snapshotRecommendation(recommendation.value));
}

function reconstructEvidence(data: PersistedEvidence): DomainResult<Evidence> {
  const common = {
    id: data.id as EvidenceId,
    missionId: data.missionId as MissionId,
    observedAt: data.observedAt as IsoDateTime,
  };
  switch (data.kind) {
    case "LOCAL_CHANGE":
      return createLocalChangeEvidence({
        ...common,
        baseCommit: data.baseCommit,
        headCommit: data.headCommit,
        commitsCreated: data.commitsCreated,
        filesChanged: data.filesChanged,
        insertions: data.insertions,
        deletions: data.deletions,
        workingTreeState: data.workingTreeState,
      });
    case "COMMIT":
      return createCommitEvidence({
        ...common,
        sha: data.sha,
        message: data.message,
        author: data.author,
        committedAt: data.committedAt as IsoDateTime,
      });
    case "PULL_REQUEST":
      return createPullRequestEvidence({
        ...common,
        number: data.number,
        url: data.url,
        repository: { ...data.repository },
        author: data.author,
        commits: data.commits,
        state: data.state,
      });
    case "ISSUE_LINK":
      return createIssueLinkEvidence({
        ...common,
        issueNumber: data.issueNumber,
        repository: { ...data.repository },
        relationship: data.relationship,
      });
    case "MERGE":
      return createMergeEvidence({
        ...common,
        pullRequestNumber: data.pullRequestNumber,
        repository: { ...data.repository },
        mergeSha: data.mergeSha,
        mergedAt: data.mergedAt as IsoDateTime,
      });
  }
}

function reconstructPullRequest(data: {
  id: string;
  missionId: string;
  observedAt: string;
  number: number;
  url: string;
  repository: { provider: "github"; owner: string; name: string };
  author: string;
  commits: string[];
  state: "OPEN" | "MERGED" | "CLOSED";
}): DomainResult<PullRequestEvidence> {
  return createPullRequestEvidence({
    id: data.id as EvidenceId,
    missionId: data.missionId as MissionId,
    observedAt: data.observedAt as IsoDateTime,
    number: data.number,
    url: data.url,
    repository: { ...data.repository },
    author: data.author,
    commits: data.commits,
    state: data.state,
  });
}

function reconstructMerge(data: {
  id: string;
  missionId: string;
  observedAt: string;
  pullRequestNumber: number;
  repository: { provider: "github"; owner: string; name: string };
  mergeSha: string;
  mergedAt: string;
}): DomainResult<MergeEvidence> {
  return createMergeEvidence({
    id: data.id as EvidenceId,
    missionId: data.missionId as MissionId,
    observedAt: data.observedAt as IsoDateTime,
    pullRequestNumber: data.pullRequestNumber,
    repository: { ...data.repository },
    mergeSha: data.mergeSha,
    mergedAt: data.mergedAt as IsoDateTime,
  });
}

function reconstructIssueLink(data: {
  id: string;
  missionId: string;
  observedAt: string;
  issueNumber: number;
  repository: { provider: "github"; owner: string; name: string };
  relationship: "CLOSING_KEYWORD" | "CROSS_REFERENCE" | "PROVIDER_VERIFIED";
}): DomainResult<IssueLinkEvidence> {
  return createIssueLinkEvidence({
    id: data.id as EvidenceId,
    missionId: data.missionId as MissionId,
    observedAt: data.observedAt as IsoDateTime,
    issueNumber: data.issueNumber,
    repository: { ...data.repository },
    relationship: data.relationship,
  });
}

function reconstructMission(data: PersistedMission): DomainResult<Mission> {
  const challenge = reconstructChallenge(data.challengeSnapshot);
  if (!challenge.ok) {
    return challenge;
  }
  const recommendation = reconstructRecommendation(data.recommendationSnapshot, challenge.value);
  if (!recommendation.ok) {
    return recommendation;
  }
  const evidenceItems: Evidence[] = [];
  for (const item of data.evidence.items) {
    const reconstructed = reconstructEvidence(item);
    if (!reconstructed.ok) {
      return reconstructed;
    }
    evidenceItems.push(reconstructed.value);
  }
  const evidence: EvidenceCollection = createEvidenceCollection(evidenceItems);

  let submittedPullRequest: PullRequestEvidence | undefined;
  if (data.submittedPullRequest !== null) {
    const reconstructed = reconstructPullRequest(data.submittedPullRequest);
    if (!reconstructed.ok) {
      return reconstructed;
    }
    submittedPullRequest = reconstructed.value;
  }
  let mergeEvidence: MergeEvidence | undefined;
  if (data.mergeEvidence !== null) {
    const reconstructed = reconstructMerge(data.mergeEvidence);
    if (!reconstructed.ok) {
      return reconstructed;
    }
    mergeEvidence = reconstructed.value;
  }
  let issueLink: IssueLinkEvidence | undefined;
  if (data.issueLink !== null) {
    const reconstructed = reconstructIssueLink(data.issueLink);
    if (!reconstructed.ok) {
      return reconstructed;
    }
    issueLink = reconstructed.value;
  }

  const workspace: WorkspaceInfo | undefined = data.workspace ? { ...data.workspace } : undefined;

  return Mission.rehydrate({
    id: data.id as MissionId,
    challengeSnapshot: challenge.value,
    recommendationSnapshot: recommendation.value,
    acceptanceContext: {
      mode: data.acceptanceContext.mode,
      workspaceRoot: data.acceptanceContext.workspaceRoot ?? undefined,
      acceptedAt: data.acceptanceContext.acceptedAt as IsoDateTime,
    },
    status: data.status,
    workspace,
    immutableBaseCommit: data.immutableBaseCommit ?? undefined,
    branch: data.branch ?? undefined,
    evidence,
    submissionVerification: data.submissionVerification,
    submittedPullRequest,
    mergeEvidence,
    issueLink,
  });
}
