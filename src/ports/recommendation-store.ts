import type { RecommendationSnapshot } from "../domain/recommendation/recommendation.js";
import type { ChallengeId } from "../domain/shared/identifiers.js";

/**
 * Persists the recommendation most recently shown to the user so that
 * mission accept can bind to the exact challenge that was discovered instead
 * of silently performing a replacement search.
 */
export interface RecommendationStore {
  /** Persist a recommendation as the single latest shown to the user. */
  save(recommendation: RecommendationSnapshot): Promise<void>;
  /** Load the latest persisted recommendation, if any. */
  loadLatest(): Promise<RecommendationSnapshot | undefined>;
  /** Load a recommendation only if it is still the latest shown. */
  load(challengeId: ChallengeId): Promise<RecommendationSnapshot | undefined>;
}
