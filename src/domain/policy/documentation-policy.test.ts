import { describe, expect, it } from "vitest";
import { documentationPolicy } from "./documentation-policy.js";

describe("DocumentationPolicy", () => {
  it("has version 1", () => {
    expect(documentationPolicy.version).toBe(1);
  });

  it("accepts a documentation-file change", () => {
    const decision = documentationPolicy.evaluateEvidence({
      commitCount: 1,
      filesChanged: ["docs/guide.md"],
      hasTrackedChanges: false,
    });
    expect(decision.accepted).toBe(true);
  });

  it("accepts tracked changes to README", () => {
    const decision = documentationPolicy.evaluateEvidence({
      commitCount: 0,
      filesChanged: ["README.md"],
      hasTrackedChanges: true,
    });
    expect(decision.accepted).toBe(true);
  });

  it("blocks when no changes exist", () => {
    const decision = documentationPolicy.evaluateEvidence({
      commitCount: 0,
      filesChanged: [],
      hasTrackedChanges: false,
    });
    expect(decision.accepted).toBe(false);
  });

  it("blocks when changes contain no documentation file", () => {
    const decision = documentationPolicy.evaluateEvidence({
      commitCount: 1,
      filesChanged: ["src/app.ts"],
      hasTrackedChanges: false,
    });
    expect(decision.accepted).toBe(false);
  });

  it("provides deterministic guidance order", () => {
    expect(documentationPolicy.missionGuidance.steps).toEqual([
      "Identify the ambiguity or missing information",
      "Verify actual project behavior",
      "Improve the explanation or example",
      "Avoid unsupported claims",
    ]);
  });
});
