import { snapshotChallenge } from "../challenge/challenge.js";
import type { Challenge } from "../challenge/challenge.js";
import type { DomainResult } from "../shared/result.js";
import { err, ok } from "../shared/result.js";
import type { IsoDateTime } from "../shared/time.js";
import type { Mood } from "./mood.js";
import type { SignalResult } from "./signal-result.js";

/** The result of evaluating a Challenge for a specific developer at a specific moment. */
export interface Recommendation {
  readonly challenge: Challenge;
  readonly mood: Mood;
  readonly reasons: readonly string[];
  readonly signalResults: readonly SignalResult[];
  readonly confidence: number;
  readonly evaluatedAt: IsoDateTime;
}

/** A deep immutable copy of a Recommendation, taken at acceptance time. */
export interface RecommendationSnapshot {
  readonly challenge: Challenge;
  readonly mood: Mood;
  readonly reasons: readonly string[];
  readonly signalResults: readonly SignalResult[];
  readonly confidence: number;
  readonly evaluatedAt: IsoDateTime;
}

export interface CreateRecommendationInput {
  readonly challenge: Challenge;
  readonly mood: Mood;
  readonly signalResults: readonly SignalResult[];
  readonly confidence: number;
  readonly evaluatedAt: IsoDateTime;
}

function isUnit(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function copyChallenge(challenge: Challenge): Challenge {
  return snapshotChallenge(challenge);
}

function copySignalResults(signalResults: readonly SignalResult[]): SignalResult[] {
  return signalResults.map((result) => ({ ...result }));
}

export function createRecommendation(
  input: CreateRecommendationInput,
): DomainResult<Recommendation> {
  if (!isUnit(input.confidence)) {
    return err("DM_INVALID_RECOMMENDATION", "confidence must be between 0 and 1");
  }
  for (const result of input.signalResults) {
    if (!isUnit(result.value) || !isUnit(result.confidence)) {
      return err(
        "DM_INVALID_RECOMMENDATION",
        "signal value and confidence must be between 0 and 1",
      );
    }
    if (result.reason.trim().length === 0) {
      return err("DM_INVALID_RECOMMENDATION", "signal reason must not be empty");
    }
  }
  const signalResults = copySignalResults(input.signalResults);
  return ok({
    challenge: copyChallenge(input.challenge),
    mood: input.mood,
    reasons: signalResults.map((result) => result.reason),
    signalResults,
    confidence: input.confidence,
    evaluatedAt: input.evaluatedAt,
  });
}

export function snapshotRecommendation(recommendation: Recommendation): RecommendationSnapshot {
  return {
    challenge: copyChallenge(recommendation.challenge),
    mood: recommendation.mood,
    reasons: [...recommendation.reasons],
    signalResults: copySignalResults(recommendation.signalResults),
    confidence: recommendation.confidence,
    evaluatedAt: recommendation.evaluatedAt,
  };
}
