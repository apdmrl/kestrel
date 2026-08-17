import type { ChallengeType } from "../../domain/challenge/challenge.js";
import { createLearnedSignals } from "../../domain/preferences/learned-signals.js";
import type { LearnedSignals } from "../../domain/preferences/learned-signals.js";

export type BehaviorSignal =
  | { readonly kind: "accept"; readonly missionType: ChallengeType }
  | { readonly kind: "complete"; readonly missionType: ChallengeType }
  | { readonly kind: "show-another"; readonly missionType: ChallengeType }
  | { readonly kind: "abandon"; readonly missionType: ChallengeType };

const WEIGHTS: Record<BehaviorSignal["kind"], number> = {
  accept: 0.2,
  complete: 0.4,
  "show-another": -0.1,
  abandon: -0.3,
};

const RECENT_WINDOW = 10;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Rebuild learned signals deterministically from behavior history. */
export function projectLearnedSignals(behaviors: readonly BehaviorSignal[]): LearnedSignals {
  const affinity: Record<string, number> = {};
  for (const behavior of behaviors) {
    const current = affinity[behavior.missionType] ?? 0;
    const next = clamp01(current + WEIGHTS[behavior.kind]);
    if (next > 0) {
      affinity[behavior.missionType] = next;
    } else {
      delete affinity[behavior.missionType];
    }
  }
  const recentPatterns = behaviors.slice(-RECENT_WINDOW).map((behavior) => behavior.missionType);
  const result = createLearnedSignals({
    missionTypeAffinity: affinity,
    recentPatterns: [...new Set(recentPatterns)],
  });
  return result.ok
    ? result.value
    : {
        languageAffinity: {},
        missionTypeAffinity: {},
        interestAffinity: {},
        scopeAffinity: {},
        recentPatterns: [],
      };
}
