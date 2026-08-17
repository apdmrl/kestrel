import type { Mood } from "./mood.js";

export type MoodWeights = Readonly<Record<string, number>>;

const MOOD_WEIGHTS: Record<Mood, MoodWeights> = {
  QUICK_WIN: {
    "mood-match": 1,
    "language-match": 1,
    interest: 2,
    scope: 3,
    "repository-health": 1,
    "issue-quality": 2,
    novelty: 0.5,
    growth: 0.5,
  },
  DEEP_DEBUGGING: {
    "mood-match": 3,
    "language-match": 0.5,
    interest: 1,
    scope: 0.5,
    "repository-health": 1,
    "issue-quality": 3,
    novelty: 0.5,
    growth: 1,
  },
  LEARN_SOMETHING_NEW: {
    "mood-match": 0.5,
    "language-match": 0.5,
    interest: 1,
    scope: 1,
    "repository-health": 0.5,
    "issue-quality": 0.5,
    novelty: 3,
    growth: 3,
  },
  HARD_CHALLENGE: {
    "mood-match": 2,
    "language-match": 0.5,
    interest: 1,
    scope: 3,
    "repository-health": 0.5,
    "issue-quality": 1,
    novelty: 1,
    growth: 2,
  },
  SURPRISE_ME: {
    "mood-match": 0.5,
    "language-match": 1,
    interest: 2,
    scope: 1,
    "repository-health": 1,
    "issue-quality": 1,
    novelty: 2,
    growth: 2,
  },
};

export function weightsForMood(mood: Mood): MoodWeights {
  return MOOD_WEIGHTS[mood];
}
