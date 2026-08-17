import { describe, expect, it } from "vitest";
import { testingPolicy } from "./testing-policy.js";

describe("TestingPolicy", () => {
  it("has version 1", () => {
    expect(testingPolicy.version).toBe(1);
  });

  it("accepts a test-file change", () => {
    const decision = testingPolicy.evaluateEvidence({
      commitCount: 1,
      filesChanged: ["test/behavior.test.ts"],
      hasTrackedChanges: false,
    });
    expect(decision.accepted).toBe(true);
  });

  it("accepts tracked changes that include a test artifact", () => {
    const decision = testingPolicy.evaluateEvidence({
      commitCount: 0,
      filesChanged: ["specs/parser.spec.ts"],
      hasTrackedChanges: true,
    });
    expect(decision.accepted).toBe(true);
  });

  it("blocks when no changes exist", () => {
    const decision = testingPolicy.evaluateEvidence({
      commitCount: 0,
      filesChanged: [],
      hasTrackedChanges: false,
    });
    expect(decision.accepted).toBe(false);
  });

  it("blocks when changes contain no test file", () => {
    const decision = testingPolicy.evaluateEvidence({
      commitCount: 2,
      filesChanged: ["src/app.ts", "src/index.ts"],
      hasTrackedChanges: false,
    });
    expect(decision.accepted).toBe(false);
    expect(decision.blockingReasons.length).toBeGreaterThan(0);
  });

  it("provides deterministic guidance order", () => {
    expect(testingPolicy.missionGuidance.steps).toEqual([
      "Identify the behavior gap",
      "Define the expected behavior",
      "Add a meaningful test",
      "Avoid implementation-detail testing",
      "Verify test quality",
    ]);
  });
});
