import { describe, expect, it } from "vitest";
import { policyFor } from "./policies.js";
import { bugFixPolicy } from "./bug-fix-policy.js";
import { testingPolicy } from "./testing-policy.js";
import { documentationPolicy } from "./documentation-policy.js";

describe("policyFor", () => {
  it("returns the matching policy for every mission type", () => {
    expect(policyFor("BUG_FIX")).toBe(bugFixPolicy);
    expect(policyFor("TESTING")).toBe(testingPolicy);
    expect(policyFor("DOCUMENTATION")).toBe(documentationPolicy);
  });

  it("exposes a policy for every mission type", () => {
    expect(policyFor("BUG_FIX").type).toBe("BUG_FIX");
    expect(policyFor("TESTING").type).toBe("TESTING");
    expect(policyFor("DOCUMENTATION").type).toBe("DOCUMENTATION");
  });
});
