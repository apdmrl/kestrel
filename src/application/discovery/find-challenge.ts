import { createKestrelError } from "../errors/kestrel-error.js";
import type { SearchIntent } from "../../domain/discovery/search-intent.js";
import type { ChallengeId } from "../../domain/shared/identifiers.js";
import type { DeveloperContext } from "../../domain/preferences/preferences.js";
import type { Mood } from "../../domain/recommendation/mood.js";
import type { Recommendation } from "../../domain/recommendation/recommendation.js";
import {
  rankCandidates,
  type Candidate,
} from "../../domain/recommendation/recommendation-engine.js";
import { planDiscovery } from "./discovery-planner.js";
import type { ChallengeSource } from "../../ports/challenge-source.js";
import type { Clock } from "../../ports/clock.js";

export interface FindChallengeDeps {
  readonly source: ChallengeSource;
  readonly developer: DeveloperContext;
  readonly clock: Clock;
}

export interface FindChallengeInput {
  readonly mode: "PICK_ONE" | "BROWSE";
  readonly mood: Mood;
  readonly intent: SearchIntent;
  readonly exclusions?: readonly ChallengeId[];
  readonly signal?: AbortSignal;
}

export type FindChallengeResult =
  | {
      readonly kind: "recommendation";
      readonly recommendation: Recommendation;
      readonly alternatives: readonly Recommendation[];
    }
  | { readonly kind: "empty" };

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw createKestrelError({
      code: "DM_PROCESS_CANCELLED",
      category: "USER_ACTION_REQUIRED",
      userMessage: "Challenge discovery was cancelled",
      suggestedActions: ["Run the command again when ready"],
      retryability: "NO_RETRY",
      recoveryStrategy: "USER_ACTION",
      severity: "INFO",
    });
  }
}

/** plan → search → normalize → cheap filter → selective enrich → recommend. */
export async function findChallenge(
  deps: FindChallengeDeps,
  input: FindChallengeInput,
): Promise<FindChallengeResult> {
  throwIfAborted(input.signal);

  const exclusions = input.exclusions ?? [];
  const challenges = await deps.source.search(input.intent);
  throwIfAborted(input.signal);

  const filtered = challenges.filter((challenge) => !exclusions.includes(challenge.id));
  if (filtered.length === 0) {
    return { kind: "empty" };
  }

  const budget = planDiscovery(input.intent).enrichmentBudget;
  const toEnrich = filtered.slice(0, budget);

  const candidates: Candidate[] = [];
  for (const challenge of toEnrich) {
    throwIfAborted(input.signal);
    const evaluationContext = await deps.source.enrich(challenge);
    candidates.push({ challenge, evaluationContext });
  }

  const ranked = rankCandidates(
    candidates,
    deps.developer,
    input.mood,
    exclusions,
    deps.clock.now(),
  );
  if (ranked.length === 0) {
    return { kind: "empty" };
  }

  const recommendations = ranked.map((entry) => entry.recommendation);
  const recommendation = recommendations[0];
  if (recommendation === undefined) {
    return { kind: "empty" };
  }

  if (input.mode === "PICK_ONE") {
    return { kind: "recommendation", recommendation, alternatives: [] };
  }
  return { kind: "recommendation", recommendation, alternatives: recommendations };
}

/** Record a weak-negative "show another" behavior without asking why. */
export async function skipRecommendation(
  deps: { readonly recordSkip: (id: ChallengeId) => Promise<void> },
  id: ChallengeId,
): Promise<void> {
  await deps.recordSkip(id);
}
