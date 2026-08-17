import { describe, expect, it } from "vitest";
import type { MissionTypePolicy } from "./mission-type-policy.js";

const fakePolicy: MissionTypePolicy = {
  type: "BUG_FIX",
  version: 1,
  discoveryHints: { labels: ["bug"], topics: ["runtime"] },
  rankingHints: { preferredSignals: ["scope"] },
  missionGuidance: { steps: ["reproduce", "fix"] },
  agentBriefPolicy: {
    investigationGoals: ["find root cause"],
    workflow: ["investigate"],
    verificationExpectations: ["tests pass"],
    riskNotes: ["none"],
  },
  reflectionHints: { prompts: ["what changed?"] },
  evaluateEvidence(input) {
    if (input.commitCount === 0 && !input.hasTrackedChanges) {
      return { accepted: false, blockingReasons: ["no changes"], warnings: [] };
    }
    return {
      accepted: true,
      blockingReasons: [],
      warnings: input.filesChanged.length === 0 ? ["consider adding regression tests"] : [],
    };
  },
};

describe("MissionTypePolicy contract", () => {
  it("reports a deterministic policy version", () => {
    expect(fakePolicy.version).toBe(1);
  });

  it("evaluates warning-only decisions without blocking completion", () => {
    const decision = fakePolicy.evaluateEvidence({
      commitCount: 2,
      filesChanged: [],
      hasTrackedChanges: true,
    });
    expect(decision.accepted).toBe(true);
    expect(decision.blockingReasons).toEqual([]);
    expect(decision.warnings).toEqual(["consider adding regression tests"]);
  });

  it("blocks when no evidence is present", () => {
    const decision = fakePolicy.evaluateEvidence({
      commitCount: 0,
      filesChanged: [],
      hasTrackedChanges: false,
    });
    expect(decision.accepted).toBe(false);
    expect(decision.blockingReasons).toHaveLength(1);
  });
});
