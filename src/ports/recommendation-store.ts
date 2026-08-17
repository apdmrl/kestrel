import type { RecommendationSnapshot } from "../domain/recommendation/recommendation.js";
import type { ChallengeId } from "../domain/shared/identifiers.js";

/**
 * Persists immutable, per-id recommendation snapshots so that mission accept
 * can bind to the exact challenge that was discovered instead of silently
 * performing a replacement search. Each snapshot is stored under its stable
 * recommendation (challenge) id and is never replaced by a later discovery.
 */
export interface RecommendationStore {
  /**
   * Persist a recommendation snapshot under its immutable id. Saving the same
   * id with identical content is idempotent; conflicting content for the same
   * id is rejected as a store conflict.
   */
  save(recommendation: RecommendationSnapshot): Promise<void>;
  /** Load the recommendation snapshot for an exact immutable id, if any. */
  load(challengeId: ChallengeId): Promise<RecommendationSnapshot | undefined>;
}
