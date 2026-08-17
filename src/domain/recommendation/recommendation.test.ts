import { describe, expect, it } from "vitest";
import { createChallenge } from "../challenge/challenge.js";
import type { ChallengeId } from "../shared/identifiers.js";
import type { IsoDateTime } from "../shared/time.js";
import type { SignalResult } from "./signal-result.js";
import { createRecommendation, snapshotRecommendation } from "./recommendation.js";

const evaluatedAt = "2026-08-15T10:00:00Z" as IsoDateTime;

function makeChallenge() {
  const result = createChallenge({
    id: "c1" as ChallengeId,
    externalId: "1",
    repository: { provider: "github", owner: "o", name: "n" },
    issueNumber: 1,
    canonicalUrl: "https://github.com/o/n/issues/1",
    title: "Original title",
    description: "desc",
    type: "BUG_FIX",
    labels: ["bug"],
    createdAt: "2026-08-01T00:00:00Z" as IsoDateTime,
    updatedAt: "2026-08-01T00:00:00Z" as IsoDateTime,
  });
  if (!result.ok) {
    throw new Error("expected ok");
  }
  return result.value;
}

function signalResults(): SignalResult[] {
  return [
    { name: "interest", value: 0.9, confidence: 0.8, reason: "matches your interests" },
    { name: "scope", value: 0.4, confidence: 0.6, reason: "moderate scope" },
  ];
}

describe("Recommendation", () => {
  it("derives reasons only from the ordered signal results", () => {
    const result = createRecommendation({
      challenge: makeChallenge(),
      mood: "QUICK_WIN",
      signalResults: signalResults(),
      confidence: 0.75,
      evaluatedAt,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.reasons).toEqual(["matches your interests", "moderate scope"]);
      expect(result.value.reasons).toEqual(result.value.signalResults.map((s) => s.reason));
    }
  });

  it.each([-0.1, 1.5])("rejects an out-of-range confidence %s", (confidence) => {
    const result = createRecommendation({
      challenge: makeChallenge(),
      mood: "QUICK_WIN",
      signalResults: signalResults(),
      confidence,
      evaluatedAt,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a signal result with an invalid value", () => {
    const result = createRecommendation({
      challenge: makeChallenge(),
      mood: "QUICK_WIN",
      signalResults: [{ name: "bad", value: 2, confidence: 0.5, reason: "invalid" }],
      confidence: 0.5,
      evaluatedAt,
    });
    expect(result.ok).toBe(false);
  });

  it("is immune to mutation of the input signal results and challenge", () => {
    const challenge = makeChallenge();
    const results = signalResults();
    const created = createRecommendation({
      challenge,
      mood: "QUICK_WIN",
      signalResults: results,
      confidence: 0.75,
      evaluatedAt,
    });
    if (!created.ok) {
      throw new Error("expected ok");
    }
    (results[0] as unknown as { reason: string }).reason = "MUTATED";
    results.push({ name: "extra", value: 1, confidence: 1, reason: "extra" });
    (challenge as unknown as { title: string }).title = "MUTATED TITLE";

    expect(created.value.reasons[0]).toBe("matches your interests");
    expect(created.value.signalResults).toHaveLength(2);
    expect(created.value.challenge.title).toBe("Original title");
  });

  it("snapshotRecommendation returns a deep independent copy", () => {
    const created = createRecommendation({
      challenge: makeChallenge(),
      mood: "SURPRISE_ME",
      signalResults: signalResults(),
      confidence: 0.5,
      evaluatedAt,
    });
    if (!created.ok) {
      throw new Error("expected ok");
    }
    const snapshot = snapshotRecommendation(created.value);

    (created.value as unknown as { challenge: { title: string } }).challenge.title = "CHANGED";
    (created.value as unknown as { reasons: string[] }).reasons[0] = "CHANGED";

    expect(snapshot.challenge.title).toBe("Original title");
    expect(snapshot.reasons[0]).toBe("matches your interests");
  });
});
