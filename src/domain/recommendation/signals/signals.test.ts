import { describe, expect, it } from "vitest";
import { createChallenge } from "../../challenge/challenge.js";
import type { Challenge } from "../../challenge/challenge.js";
import { createEvaluationContext } from "../../challenge/evaluation-context.js";
import type { EvaluationContext } from "../../challenge/evaluation-context.js";
import {
  createExplicitPreferences,
  resolveDeveloperContext,
} from "../../preferences/preferences.js";
import { createLearnedSignals } from "../../preferences/learned-signals.js";
import type { DeveloperContext } from "../../preferences/preferences.js";
import type { ChallengeId } from "../../shared/identifiers.js";
import type { IsoDateTime } from "../../shared/time.js";
import type { SignalInput } from "./shared.js";
import { evaluateMoodMatch } from "./mood-match.js";
import { evaluateLanguageMatch } from "./language-match.js";
import { evaluateInterest } from "./interest.js";
import { evaluateScope } from "./scope.js";
import { evaluateRepositoryHealth } from "./repository-health.js";
import { evaluateIssueQuality } from "./issue-quality.js";
import { evaluateNovelty } from "./novelty.js";
import { evaluateGrowth } from "./growth.js";

const observedAt = "2026-08-15T10:00:00Z" as IsoDateTime;

function challenge(
  overrides: Partial<{
    language?: string;
    labels?: string[];
    topics?: string[];
    type?: "BUG_FIX" | "TESTING" | "DOCUMENTATION";
  }> = {},
): Challenge {
  const result = createChallenge({
    id: "c1" as ChallengeId,
    externalId: "1",
    repository: { provider: "github", owner: "o", name: "n" },
    issueNumber: 1,
    canonicalUrl: "https://github.com/o/n/issues/1",
    title: "t",
    description: "d",
    type: overrides.type ?? "BUG_FIX",
    ...(overrides.labels !== undefined ? { labels: overrides.labels } : {}),
    ...(overrides.language !== undefined ? { language: overrides.language } : {}),
    ...(overrides.topics !== undefined ? { topics: overrides.topics } : {}),
    createdAt: "2026-08-01T00:00:00Z" as IsoDateTime,
    updatedAt: "2026-08-01T00:00:00Z" as IsoDateTime,
  });
  if (!result.ok) {
    throw new Error("expected ok");
  }
  return result.value;
}

function context(
  overrides: Partial<{ health?: number; quality?: number }> = {},
): EvaluationContext {
  const result = createEvaluationContext({
    observedAt,
    ...(overrides.health !== undefined ? { repositoryHealth: overrides.health } : {}),
    ...(overrides.quality !== undefined ? { issueQuality: overrides.quality } : {}),
    confidence: 0.5,
  });
  if (!result.ok) {
    throw new Error("expected ok");
  }
  return result.value;
}

function developer(): DeveloperContext {
  const explicit = createExplicitPreferences({ preferredLanguages: ["typescript"] });
  const learned = createLearnedSignals({
    languageAffinity: { typescript: 0.8 },
    interestAffinity: { testing: 0.9 },
    scopeAffinity: { small: 0.8, medium: 0.5, large: 0.2 },
    recentPatterns: ["BUG_FIX"],
  });
  if (!explicit.ok || !learned.ok) {
    throw new Error("expected ok");
  }
  return resolveDeveloperContext(explicit.value, learned.value);
}

function input(overrides: Partial<SignalInput> = {}): SignalInput {
  return {
    challenge: challenge(),
    context: context(),
    developer: developer(),
    mood: "QUICK_WIN",
    ...overrides,
  };
}

function expectSignal(signal: ReturnType<typeof evaluateMoodMatch>, name: string) {
  expect(signal.name).toBe(name);
  expect(signal.value).toBeGreaterThanOrEqual(0);
  expect(signal.value).toBeLessThanOrEqual(1);
  expect(signal.confidence).toBeGreaterThanOrEqual(0);
  expect(signal.confidence).toBeLessThanOrEqual(1);
  expect(signal.reason.length).toBeGreaterThan(0);
}

describe("signal evaluators", () => {
  it("mood match reaches maximum for a quick-win good-first-issue challenge", () => {
    const signal = evaluateMoodMatch(
      input({ challenge: challenge({ labels: ["good first issue"] }) }),
    );
    expectSignal(signal, "mood-match");
    expect(signal.value).toBe(1);
  });

  it("language match is maximum for a preferred language and zero confidence when missing", () => {
    expect(
      evaluateLanguageMatch(input({ challenge: challenge({ language: "typescript" }) })).value,
    ).toBe(1);
    const missing = evaluateLanguageMatch(input({ challenge: challenge({}) }));
    expect(missing.confidence).toBe(0);
  });

  it("interest is maximum for a matching affinity and zero-confidence when missing", () => {
    const signal = evaluateInterest(input({ challenge: challenge({ labels: ["testing"] }) }));
    expectSignal(signal, "interest");
    expect(signal.value).toBe(0.9);
    const emptyExplicit = createExplicitPreferences({});
    const emptyLearned = createLearnedSignals({});
    const empty = evaluateInterest(
      input({
        developer: resolveDeveloperContext(
          emptyExplicit.ok ? emptyExplicit.value : ({} as never),
          emptyLearned.ok ? emptyLearned.value : ({} as never),
        ),
      }),
    );
    expect(empty.confidence).toBe(0);
  });

  it("scope uses the challenge label to pick an affinity", () => {
    const signal = evaluateScope(input({ challenge: challenge({ labels: ["good first issue"] }) }));
    expectSignal(signal, "scope");
    expect(signal.value).toBe(0.8);
  });

  it("repository health and issue quality reflect observations or fall back", () => {
    expect(evaluateRepositoryHealth(input({ context: context({ health: 0.9 }) })).value).toBe(0.9);
    expect(evaluateRepositoryHealth(input({ context: context() })).confidence).toBe(0);
    expect(evaluateIssueQuality(input({ context: context({ quality: 0.7 }) })).value).toBe(0.7);
  });

  it("novelty is maximum for work unlike recent patterns", () => {
    const signal = evaluateNovelty(
      input({ challenge: challenge({ language: "python", labels: ["docs"] }) }),
    );
    expectSignal(signal, "novelty");
    expect(signal.value).toBe(1);
  });

  it("growth is maximum for an unfamiliar language", () => {
    const signal = evaluateGrowth(input({ challenge: challenge({ language: "rust" }) }));
    expectSignal(signal, "growth");
    expect(signal.value).toBe(1);
  });
});
