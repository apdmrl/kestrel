import type { Challenge, ChallengeType } from "../../domain/challenge/challenge.js";
import { createChallenge } from "../../domain/challenge/challenge.js";
import type { RepositoryIdentity } from "../../domain/challenge/repository-identity.js";
import type { ChallengeId } from "../../domain/shared/identifiers.js";
import type { DomainViolation } from "../../domain/shared/result.js";
import { parseIsoDateTime } from "../../domain/shared/time.js";

export interface RawGitHubIssue {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  readonly body?: string | null;
  readonly state: string;
  readonly labels?: readonly { name?: string }[];
  readonly pull_request?: unknown;
  readonly html_url?: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export type IssueNormalization =
  | { kind: "challenge"; challenge: Challenge }
  | { kind: "skip"; reason: "pull_request" | "closed" | "archived" }
  | { kind: "invalid"; error: DomainViolation };

export function inferChallengeType(labels: readonly string[]): ChallengeType {
  const lower = labels.map((label) => label.toLowerCase());
  if (lower.some((label) => /test|spec|coverage/.test(label))) {
    return "TESTING";
  }
  if (lower.some((label) => /doc|documentation/.test(label))) {
    return "DOCUMENTATION";
  }
  return "BUG_FIX";
}

/** Normalize a raw GitHub issue into a Challenge, or report why it is skipped. */
export function normalizeIssue(input: {
  readonly issue: RawGitHubIssue;
  readonly repository: RepositoryIdentity;
  readonly language?: string;
  readonly archived?: boolean;
  readonly issueId: ChallengeId;
}): IssueNormalization {
  if (input.issue.pull_request !== undefined) {
    return { kind: "skip", reason: "pull_request" };
  }
  if (input.issue.state !== "open") {
    return { kind: "skip", reason: "closed" };
  }
  if (input.archived === true) {
    return { kind: "skip", reason: "archived" };
  }

  const createdAt = parseIsoDateTime(input.issue.created_at);
  if (!createdAt.ok) {
    return { kind: "invalid", error: createdAt.error };
  }
  const updatedAt = parseIsoDateTime(input.issue.updated_at);
  if (!updatedAt.ok) {
    return { kind: "invalid", error: updatedAt.error };
  }

  const labels = (input.issue.labels ?? [])
    .map((label) => label.name)
    .filter((name): name is string => name !== undefined && name.length > 0);

  const canonicalUrl =
    input.issue.html_url ??
    "https://github.com/" +
      input.repository.owner +
      "/" +
      input.repository.name +
      "/issues/" +
      input.issue.number;

  const result = createChallenge({
    id: input.issueId,
    externalId: String(input.issue.id),
    repository: input.repository,
    issueNumber: input.issue.number,
    canonicalUrl,
    title: input.issue.title,
    description: input.issue.body ?? "",
    type: inferChallengeType(labels),
    labels,
    ...(input.language !== undefined ? { language: input.language } : {}),
    topics: [],
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
  });
  if (!result.ok) {
    return { kind: "invalid", error: result.error };
  }
  return { kind: "challenge", challenge: result.value };
}
