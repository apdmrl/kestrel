import { describe, expect, it } from "vitest";
import type { IsoDateTime } from "../shared/time.js";
import { createEvaluationContext } from "./evaluation-context.js";

const observedAt = "2026-08-15T00:00:00Z" as IsoDateTime;

describe("EvaluationContext", () => {
  it("builds with only the observedAt and confidence", () => {
    const result = createEvaluationContext({ observedAt, confidence: 0.8 });
    expect(result).toEqual({
      ok: true,
      value: { observedAt, confidence: 0.8 },
    });
  });

  it.each([-0.1, 1.5, Number.NaN])("rejects an out-of-range confidence %s", (confidence) => {
    expect(createEvaluationContext({ observedAt, confidence }).ok).toBe(false);
  });

  it("rejects an out-of-range bounded observation", () => {
    expect(createEvaluationContext({ observedAt, confidence: 0.5, repositoryHealth: 1.2 }).ok).toBe(
      false,
    );
  });

  it("rejects a negative or non-integer competing-work count", () => {
    expect(createEvaluationContext({ observedAt, confidence: 0.5, competingWork: -1 }).ok).toBe(
      false,
    );
    expect(createEvaluationContext({ observedAt, confidence: 0.5, competingWork: 1.5 }).ok).toBe(
      false,
    );
  });

  it("accepts a fully populated context", () => {
    const result = createEvaluationContext({
      observedAt,
      repositoryHealth: 0.9,
      repositoryInterest: 0.7,
      contributionGuide: true,
      competingWork: 3,
      maintainerActivity: 0.5,
      issueQuality: 0.8,
      confidence: 0.6,
    });
    expect(result.ok).toBe(true);
  });
});
