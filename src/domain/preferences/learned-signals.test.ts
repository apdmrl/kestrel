import { describe, expect, it } from "vitest";
import { createLearnedSignals } from "./learned-signals.js";

describe("LearnedSignals", () => {
  it("applies empty defaults", () => {
    const result = createLearnedSignals({});
    expect(result).toEqual({
      ok: true,
      value: {
        languageAffinity: {},
        missionTypeAffinity: {},
        interestAffinity: {},
        scopeAffinity: {},
        recentPatterns: [],
      },
    });
  });

  it.each([{ python: 1.5 }, { python: -0.1 }, { python: Number.NaN }])(
    "rejects an invalid language affinity value (%o)",
    (languageAffinity) => {
      expect(createLearnedSignals({ languageAffinity }).ok).toBe(false);
    },
  );

  it("rejects an invalid mission-type affinity value", () => {
    expect(
      createLearnedSignals({
        missionTypeAffinity: { BUG_FIX: 0.5, TESTING: 0.2, DOCUMENTATION: 1.2 },
      }).ok,
    ).toBe(false);
  });

  it("deduplicates recent patterns", () => {
    const result = createLearnedSignals({
      recentPatterns: ["BUG_FIX", "BUG_FIX", "DOCUMENTATION"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.recentPatterns).toEqual(["BUG_FIX", "DOCUMENTATION"]);
    }
  });
});
