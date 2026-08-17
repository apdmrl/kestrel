import type { ChallengeId } from "../shared/identifiers.js";
import type { DomainResult } from "../shared/result.js";
import { err, ok } from "../shared/result.js";
import type { ExplicitPreferences } from "../preferences/preferences.js";
import type { Mood } from "../recommendation/mood.js";
import type { ChallengeType } from "../challenge/challenge.js";

/** A provider-neutral description of what to search for and how much to spend. */
export interface SearchIntent {
  readonly mood: Mood;
  readonly explicitPreferences: ExplicitPreferences;
  readonly missionTypeOverride: ChallengeType | undefined;
  readonly exclusions: readonly ChallengeId[];
  readonly pageBudget: number;
}

export interface CreateSearchIntentInput {
  readonly mood: Mood;
  readonly explicitPreferences: ExplicitPreferences;
  readonly missionTypeOverride?: ChallengeType;
  readonly exclusions?: readonly ChallengeId[];
  readonly pageBudget: number;
}

export function createSearchIntent(input: CreateSearchIntentInput): DomainResult<SearchIntent> {
  if (!Number.isInteger(input.pageBudget) || input.pageBudget <= 0) {
    return err("DM_INVALID_INTENT", "pageBudget must be a positive integer");
  }
  const exclusions = [...new Set(input.exclusions ?? [])];
  return ok({
    mood: input.mood,
    explicitPreferences: input.explicitPreferences,
    missionTypeOverride: input.missionTypeOverride,
    exclusions,
    pageBudget: input.pageBudget,
  });
}
