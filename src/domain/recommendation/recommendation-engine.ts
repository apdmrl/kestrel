import type { Challenge } from "../challenge/challenge.js";
import type { EvaluationContext } from "../challenge/evaluation-context.js";
import type { ChallengeId } from "../shared/identifiers.js";
import type { IsoDateTime } from "../shared/time.js";
import type { DeveloperContext } from "../preferences/preferences.js";
import type { Mood } from "./mood.js";
import { weightsForMood } from "./mood-policy.js";
import { createRecommendation } from "./recommendation.js";
import type { Recommendation } from "./recommendation.js";
import type { SignalResult } from "./signal-result.js";
import type { SignalInput } from "./signals/shared.js";
import { evaluateMoodMatch } from "./signals/mood-match.js";
import { evaluateLanguageMatch } from "./signals/language-match.js";
import { evaluateInterest } from "./signals/interest.js";
import { evaluateScope } from "./signals/scope.js";
import { evaluateRepositoryHealth } from "./signals/repository-health.js";
import { evaluateIssueQuality } from "./signals/issue-quality.js";
import { evaluateNovelty } from "./signals/novelty.js";
import { evaluateGrowth } from "./signals/growth.js";

export interface Candidate {
  readonly challenge: Challenge;
  readonly evaluationContext: EvaluationContext;
}

type Evaluator = (input: SignalInput) => SignalResult;

const EVALUATORS: readonly Evaluator[] = [
  evaluateMoodMatch,
  evaluateLanguageMatch,
  evaluateInterest,
  evaluateScope,
  evaluateRepositoryHealth,
  evaluateIssueQuality,
  evaluateNovelty,
  evaluateGrowth,
];

export interface RankedCandidate {
  readonly candidate: Candidate;
  readonly recommendation: Recommendation;
}

/** Rank candidates by weighted signal composition, keeping the numeric score internal. */
export function rankCandidates(
  candidates: readonly Candidate[],
  developer: DeveloperContext,
  mood: Mood,
  excludedIds: readonly ChallengeId[],
  evaluatedAt: IsoDateTime,
): RankedCandidate[] {
  const weights = weightsForMood(mood);
  const scored = candidates
    .filter((candidate) => !excludedIds.includes(candidate.challenge.id))
    .map((candidate) => {
      const input: SignalInput = {
        challenge: candidate.challenge,
        context: candidate.evaluationContext,
        developer,
        mood,
      };
      const signalResults = EVALUATORS.map((evaluator) => evaluator(input));
      const score = signalResults.reduce(
        (sum, signal) => sum + signal.value * signal.confidence * (weights[signal.name] ?? 0),
        0,
      );
      const totalConfidenceWeight = signalResults.reduce(
        (sum, signal) => sum + (weights[signal.name] ?? 0),
        0,
      );
      const confidence =
        totalConfidenceWeight > 0
          ? signalResults.reduce(
              (sum, signal) => sum + signal.confidence * (weights[signal.name] ?? 0),
              0,
            ) / totalConfidenceWeight
          : 0;
      const created = createRecommendation({
        challenge: candidate.challenge,
        mood,
        signalResults,
        confidence,
        evaluatedAt,
      });
      if (!created.ok) {
        return undefined;
      }
      return { candidate, recommendation: created.value, score };
    })
    .filter(
      (item): item is { candidate: Candidate; recommendation: Recommendation; score: number } =>
        item !== undefined,
    )
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.candidate.challenge.id < b.candidate.challenge.id ? -1 : 1;
    });

  return scored.map(({ candidate, recommendation }) => ({ candidate, recommendation }));
}

/** Select the single best recommendation, or undefined when no candidate remains. */
export function recommend(
  candidates: readonly Candidate[],
  developer: DeveloperContext,
  mood: Mood,
  excludedIds: readonly ChallengeId[],
  evaluatedAt: IsoDateTime,
): Recommendation | undefined {
  const ranked = rankCandidates(candidates, developer, mood, excludedIds, evaluatedAt);
  return ranked[0]?.recommendation;
}
