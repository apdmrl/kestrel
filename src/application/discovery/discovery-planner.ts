import type { ChallengeId } from "../../domain/shared/identifiers.js";
import type { ChallengeType } from "../../domain/challenge/challenge.js";
import type { SearchIntent } from "../../domain/discovery/search-intent.js";
import { policyFor } from "../../domain/policy/policies.js";
import type { Mood } from "../../domain/recommendation/mood.js";

export const MAX_PAGE_BUDGET = 5;
export const MAX_ENRICHMENT_BUDGET = 3;

export interface SearchQuery {
  readonly labels: readonly string[];
  readonly topics: readonly string[];
  readonly language: string | undefined;
  readonly missionType: ChallengeType;
}

export interface DiscoveryBatch {
  readonly query: SearchQuery;
  readonly pageBudget: number;
}

export interface DiscoveryPlan {
  readonly missionType: ChallengeType;
  readonly batches: readonly DiscoveryBatch[];
  readonly enrichmentBudget: number;
  readonly excludedIds: readonly ChallengeId[];
}

const MOOD_HINTS: Record<Mood, { labels: readonly string[]; topics: readonly string[] }> = {
  QUICK_WIN: { labels: ["good first issue"], topics: [] },
  DEEP_DEBUGGING: { labels: ["bug"], topics: ["debugging"] },
  LEARN_SOMETHING_NEW: { labels: [], topics: ["documentation"] },
  HARD_CHALLENGE: { labels: ["help wanted"], topics: [] },
  SURPRISE_ME: { labels: [], topics: [] },
};

function dedupe(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

/** Deterministically translate a SearchIntent into bounded, provider-neutral batches. */
export function planDiscovery(intent: SearchIntent): DiscoveryPlan {
  const missionType = intent.missionTypeOverride ?? "BUG_FIX";
  const policy = policyFor(missionType);
  const moodHints = MOOD_HINTS[intent.mood];

  const pageBudget = Math.max(1, Math.min(intent.pageBudget, MAX_PAGE_BUDGET));

  const query: SearchQuery = {
    labels: dedupe([...policy.discoveryHints.labels, ...moodHints.labels]),
    topics: dedupe([...policy.discoveryHints.topics, ...moodHints.topics]),
    language: intent.explicitPreferences.preferredLanguages[0],
    missionType,
  };

  return {
    missionType,
    batches: [{ query, pageBudget }],
    enrichmentBudget: Math.min(pageBudget, MAX_ENRICHMENT_BUDGET),
    excludedIds: [...intent.exclusions],
  };
}
