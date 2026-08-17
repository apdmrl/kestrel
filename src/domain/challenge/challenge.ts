import type { ChallengeId } from "../shared/identifiers.js";
import type { DomainResult } from "../shared/result.js";
import { err, ok } from "../shared/result.js";
import type { IsoDateTime } from "../shared/time.js";
import type { RepositoryIdentity } from "./repository-identity.js";

export type ChallengeType = "BUG_FIX" | "TESTING" | "DOCUMENTATION";

/** Provider provenance, kept separate from the normalized challenge truth. */
export interface ChallengeSourceReference {
  readonly provider: "github";
  readonly externalId: string;
  readonly repository: RepositoryIdentity;
  readonly issueNumber: number;
  readonly canonicalUrl: string;
}

/** A provider-normalized, largely immutable challenge. */
export interface Challenge {
  readonly id: ChallengeId;
  readonly source: ChallengeSourceReference;
  readonly repository: RepositoryIdentity;
  readonly title: string;
  readonly description: string;
  readonly type: ChallengeType;
  readonly labels: readonly string[];
  readonly language: string | undefined;
  readonly topics: readonly string[];
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

export interface CreateChallengeInput {
  readonly id: ChallengeId;
  readonly externalId: string;
  readonly repository: RepositoryIdentity;
  readonly issueNumber: number;
  readonly canonicalUrl: string;
  readonly title: string;
  readonly description: string;
  readonly type: ChallengeType;
  readonly labels?: readonly string[];
  readonly language?: string;
  readonly topics?: readonly string[];
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

function dedupe(values: readonly string[] | undefined): readonly string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const raw of values ?? []) {
    const trimmed = raw.trim();
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      output.push(trimmed);
    }
  }
  return output;
}

export function createChallenge(input: CreateChallengeInput): DomainResult<Challenge> {
  if (input.title.trim().length === 0) {
    return err("DM_INVALID_CHALLENGE", "Challenge title must not be empty");
  }
  if (Date.parse(input.updatedAt) < Date.parse(input.createdAt)) {
    return err("DM_INVALID_CHALLENGE", "updatedAt must not precede createdAt");
  }
  const repository: RepositoryIdentity = { ...input.repository };
  return ok({
    id: input.id,
    source: {
      provider: "github",
      externalId: input.externalId,
      repository,
      issueNumber: input.issueNumber,
      canonicalUrl: input.canonicalUrl,
    },
    repository,
    title: input.title,
    description: input.description,
    type: input.type,
    labels: dedupe(input.labels),
    language: input.language,
    topics: dedupe(input.topics),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  });
}
