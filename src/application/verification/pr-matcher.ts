import type { RepositoryIdentity } from "../../domain/challenge/repository-identity.js";

export interface PrMatchInput {
  readonly repository: RepositoryIdentity;
  readonly prRepository: RepositoryIdentity;
  readonly expectedAuthor: string;
  readonly prAuthor: string;
  readonly missionCommits: readonly string[];
  readonly prCommits: readonly string[];
  readonly missionBranch?: string;
  readonly prBranch?: string;
}

export type PrMatchResult =
  | { readonly kind: "match"; readonly confidence: number; readonly reasons: readonly string[] }
  | { readonly kind: "no-match"; readonly reasons: readonly string[] };

function sameRepository(a: RepositoryIdentity, b: RepositoryIdentity): boolean {
  return a.owner === b.owner && a.name === b.name && a.provider === b.provider;
}

/**
 * Match a pull request to mission work by repository identity, authenticated
 * author, and commit overlap. Branch names are supporting context only.
 */
export function matchPullRequest(input: PrMatchInput): PrMatchResult {
  if (!sameRepository(input.repository, input.prRepository)) {
    return { kind: "no-match", reasons: ["the pull request belongs to a different repository"] };
  }
  if (input.prAuthor !== input.expectedAuthor) {
    return {
      kind: "no-match",
      reasons: ["the pull request was not opened by the authenticated author"],
    };
  }
  const missionCommitSet = new Set(input.missionCommits);
  const overlap = input.prCommits.filter((commit) => missionCommitSet.has(commit));
  if (overlap.length === 0) {
    return { kind: "no-match", reasons: ["no mission commits appear in the pull request"] };
  }
  const confidence = Math.min(1, overlap.length / Math.max(1, input.missionCommits.length));
  const reasons: string[] = ["mission commits appear in the pull request"];
  if (
    input.missionBranch !== undefined &&
    input.prBranch !== undefined &&
    input.missionBranch === input.prBranch
  ) {
    reasons.push("branch names match (supporting context only)");
  }
  return { kind: "match", confidence, reasons };
}
