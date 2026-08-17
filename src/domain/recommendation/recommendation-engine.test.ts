import { describe, expect, it } from "vitest";
import { createChallenge } from "../challenge/challenge.js";
import type { Challenge } from "../challenge/challenge.js";
import { createEvaluationContext } from "../challenge/evaluation-context.js";
import type { EvaluationContext } from "../challenge/evaluation-context.js";
import { createExplicitPreferences, resolveDeveloperContext } from "../preferences/preferences.js";
import { createLearnedSignals } from "../preferences/learned-signals.js";
import type { DeveloperContext } from "../preferences/preferences.js";
import type { ChallengeId } from "../shared/identifiers.js";
import type { IsoDateTime } from "../shared/time.js";
import type { Mood } from "./mood.js";
import { weightsForMood } from "./mood-policy.js";
import { recommend, rankCandidates, type Candidate } from "./recommendation-engine.js";

const evaluatedAt = "2026-08-15T10:00:00Z" as IsoDateTime;
const observedAt = evaluatedAt;

function makeChallenge(id: string, language: string, labels: string[]): Challenge {
  const result = createChallenge({
    id: id as ChallengeId,
    externalId: id,
    repository: { provider: "github", owner: "o", name: "n" },
    issueNumber: Number(id.slice(1)),
    canonicalUrl: "https://github.com/o/n/issues/" + id,
    title: "t " + id,
    description: "d",
    type: "BUG_FIX",
    labels,
    language,
    createdAt: "2026-08-01T00:00:00Z" as IsoDateTime,
    updatedAt: "2026-08-01T00:00:00Z" as IsoDateTime,
  });
  if (!result.ok) {
    throw new Error("expected ok");
  }
  return result.value;
}

function context(health?: number, quality?: number): EvaluationContext {
  const result = createEvaluationContext({
    observedAt,
    ...(health !== undefined ? { repositoryHealth: health } : {}),
    ...(quality !== undefined ? { issueQuality: quality } : {}),
    confidence: 0.6,
  });
  if (!result.ok) {
    throw new Error("expected ok");
  }
  return result.value;
}

function candidate(id: string, language: string, labels: string[]): Candidate {
  return { challenge: makeChallenge(id, language, labels), evaluationContext: context(0.8, 0.8) };
}

function developer(): DeveloperContext {
  const explicit = createExplicitPreferences({ preferredLanguages: ["typescript"] });
  const learned = createLearnedSignals({
    languageAffinity: { typescript: 0.8 },
    interestAffinity: { testing: 0.9 },
    scopeAffinity: { small: 0.8 },
    recentPatterns: [],
  });
  if (!explicit.ok || !learned.ok) {
    throw new Error("expected ok");
  }
  return resolveDeveloperContext(explicit.value, learned.value);
}

describe("mood-policy", () => {
  it.each([
    "QUICK_WIN",
    "DEEP_DEBUGGING",
    "LEARN_SOMETHING_NEW",
    "HARD_CHALLENGE",
    "SURPRISE_ME",
  ] as Mood[])("provides a weight profile for %s", (mood) => {
    const weights = weightsForMood(mood);
    expect(Object.keys(weights).length).toBe(8);
  });
});

describe("recommend", () => {
  it("returns the best recommendation with consistent explanations", () => {
    const candidates = [
      candidate("c1", "typescript", ["good first issue"]),
      candidate("c2", "rust", ["bug"]),
    ];
    const result = recommend(candidates, developer(), "QUICK_WIN", [], evaluatedAt);
    expect(result).toBeDefined();
    expect(result?.reasons).toEqual(result?.signalResults.map((s) => s.reason));
  });

  it("returns undefined when there are no candidates", () => {
    expect(recommend([], developer(), "QUICK_WIN", [], evaluatedAt)).toBeUndefined();
  });

  it("excludes prior candidates for 'show another'", () => {
    const candidates = [candidate("c1", "typescript", ["bug"])];
    expect(
      recommend(candidates, developer(), "QUICK_WIN", ["c1" as ChallengeId], evaluatedAt),
    ).toBeUndefined();
  });

  it("orders ties stably by challenge id", () => {
    const a = candidate("c1", "typescript", ["bug"]);
    const b = candidate("c2", "typescript", ["bug"]);
    const ranked = rankCandidates([a, b], developer(), "QUICK_WIN", [], evaluatedAt);
    expect(ranked.map((r) => r.candidate.challenge.id)).toEqual(["c1", "c2"]);
  });
});
