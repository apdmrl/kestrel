import { describe, expect, it } from "vitest";
import { bugFixPolicy } from "./bug-fix-policy.js";

describe("BugFixPolicy", () => {
  it("has version 1", () => {
    expect(bugFixPolicy.version).toBe(1);
  });

  it("accepts commits since base", () => {
    const decision = bugFixPolicy.evaluateEvidence({
      commitCount: 1,
      filesChanged: ["src/app.ts"],
      hasTrackedChanges: false,
    });
    expect(decision.accepted).toBe(true);
  });

  it("accepts tracked changes without commits", () => {
    const decision = bugFixPolicy.evaluateEvidence({
      commitCount: 0,
      filesChanged: ["src/app.ts"],
      hasTrackedChanges: true,
    });
    expect(decision.accepted).toBe(true);
  });

  it("blocks when no changes exist", () => {
    const decision = bugFixPolicy.evaluateEvidence({
      commitCount: 0,
      filesChanged: [],
      hasTrackedChanges: false,
    });
    expect(decision.accepted).toBe(false);
    expect(decision.blockingReasons.length).toBeGreaterThan(0);
  });

  it("warns, without blocking, when no regression-test change is detected", () => {
    const decision = bugFixPolicy.evaluateEvidence({
      commitCount: 1,
      filesChanged: ["src/app.ts"],
      hasTrackedChanges: false,
    });
    expect(decision.accepted).toBe(true);
    expect(decision.warnings.length).toBeGreaterThan(0);
  });

  it("does not warn when a test file changed", () => {
    const decision = bugFixPolicy.evaluateEvidence({
      commitCount: 1,
      filesChanged: ["src/app.test.ts"],
      hasTrackedChanges: false,
    });
    expect(decision.accepted).toBe(true);
    expect(decision.warnings).toEqual([]);
  });

  it("provides deterministic guidance order", () => {
    expect(bugFixPolicy.missionGuidance.steps).toEqual([
      "Understand the reported behavior",
      "Reproduce the failure",
      "Form a hypothesis",
      "Find the root cause",
      "Add regression coverage where practical",
      "Make a minimal justified fix",
      "Verify the fix",
    ]);
  });
});
