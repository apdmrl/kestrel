import type { Recommendation } from "../../domain/recommendation/recommendation.js";
import type { SignalResult } from "../../domain/recommendation/signal-result.js";

export interface RecommendationDetails {
  readonly challengeId: string;
  readonly mood: string;
  readonly confidence: number;
  readonly reasons: readonly string[];
  readonly signalResults: readonly SignalResult[];
}

/** Project the explainable details of a recommendation ("Why this?"). */
export function getRecommendationDetails(recommendation: Recommendation): RecommendationDetails {
  return {
    challengeId: recommendation.challenge.id,
    mood: recommendation.mood,
    confidence: recommendation.confidence,
    reasons: recommendation.reasons,
    signalResults: recommendation.signalResults,
  };
}
