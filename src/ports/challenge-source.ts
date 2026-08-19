import type { Challenge } from "../domain/challenge/challenge.js";
import type { EvaluationContext } from "../domain/challenge/evaluation-context.js";
import type { SearchIntent } from "../domain/discovery/search-intent.js";

/** Provider-neutral challenge discovery and selective enrichment. */
export interface ChallengeSource {
  search(intent: SearchIntent, signal?: AbortSignal): Promise<readonly Challenge[]>;
  enrich(challenge: Challenge, signal?: AbortSignal): Promise<EvaluationContext>;
}
