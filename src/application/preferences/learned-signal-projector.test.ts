import { describe, expect, it } from "vitest";
import { projectLearnedSignals, type BehaviorSignal } from "./learned-signal-projector.js";

describe("projectLearnedSignals", () => {
  it("rebuilds from empty history", () => {
    const signals = projectLearnedSignals([]);
    expect(signals.missionTypeAffinity).toEqual({});
    expect(signals.recentPatterns).toEqual([]);
  });

  it("applies positive, strong-positive, weak-negative, and negative weights", () => {
    const behaviors: BehaviorSignal[] = [
      { kind: "accept", missionType: "BUG_FIX" },
      { kind: "complete", missionType: "BUG_FIX" },
      { kind: "show-another", missionType: "TESTING" },
      { kind: "abandon", missionType: "DOCUMENTATION" },
    ];
    const signals = projectLearnedSignals(behaviors);
    expect(signals.missionTypeAffinity.BUG_FIX).toBeCloseTo(0.6);
    expect(signals.missionTypeAffinity.TESTING).toBeUndefined();
  });

  it("bounds affinity values", () => {
    const behaviors: BehaviorSignal[] = Array.from({ length: 10 }, () => ({
      kind: "complete" as const,
      missionType: "BUG_FIX" as const,
    }));
    const signals = projectLearnedSignals(behaviors);
    expect(signals.missionTypeAffinity.BUG_FIX).toBe(1);
  });

  it("is deterministic on replay", () => {
    const behaviors: BehaviorSignal[] = [
      { kind: "accept", missionType: "BUG_FIX" },
      { kind: "abandon", missionType: "TESTING" },
    ];
    const a = projectLearnedSignals(behaviors);
    const b = projectLearnedSignals(behaviors);
    expect(a).toEqual(b);
  });

  it("keeps a bounded recent-pattern window", () => {
    const behaviors: BehaviorSignal[] = Array.from({ length: 20 }, (_, i) => ({
      kind: "accept" as const,
      missionType: (i % 3 === 0 ? "BUG_FIX" : i % 3 === 1 ? "TESTING" : "DOCUMENTATION") as
        "BUG_FIX" | "TESTING" | "DOCUMENTATION",
    }));
    const signals = projectLearnedSignals(behaviors);
    expect(signals.recentPatterns.length).toBeLessThanOrEqual(3);
  });
});
