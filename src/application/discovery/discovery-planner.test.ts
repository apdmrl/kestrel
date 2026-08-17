import { describe, expect, it } from "vitest";
import type { ChallengeId } from "../../domain/shared/identifiers.js";
import { createExplicitPreferences } from "../../domain/preferences/preferences.js";
import { createSearchIntent } from "../../domain/discovery/search-intent.js";
import type { Mood } from "../../domain/recommendation/mood.js";
import { planDiscovery } from "./discovery-planner.js";

function prefs(languages?: string[]) {
  const result = createExplicitPreferences({
    ...(languages !== undefined ? { preferredLanguages: languages } : {}),
  });
  if (!result.ok) {
    throw new Error("expected ok");
  }
  return result.value;
}

function intent(input: {
  mood?: Mood;
  missionTypeOverride?: "BUG_FIX" | "TESTING" | "DOCUMENTATION";
  pageBudget?: number;
  exclusions?: string[];
  languages?: string[];
}) {
  const result = createSearchIntent({
    mood: input.mood ?? "QUICK_WIN",
    explicitPreferences: prefs(input.languages),
    ...(input.missionTypeOverride !== undefined
      ? { missionTypeOverride: input.missionTypeOverride }
      : {}),
    ...(input.exclusions !== undefined ? { exclusions: input.exclusions as ChallengeId[] } : {}),
    pageBudget: input.pageBudget ?? 3,
  });
  if (!result.ok) {
    throw new Error("expected ok");
  }
  return result.value;
}

describe("planDiscovery", () => {
  it.each([
    "QUICK_WIN",
    "DEEP_DEBUGGING",
    "LEARN_SOMETHING_NEW",
    "HARD_CHALLENGE",
    "SURPRISE_ME",
  ] as Mood[])("plans deterministically for mood %s", (mood) => {
    const plan = planDiscovery(intent({ mood }));
    expect(plan.batches).toHaveLength(1);
    expect(plan.missionType).toBe("BUG_FIX");
    expect(plan.enrichmentBudget).toBeGreaterThanOrEqual(1);
  });

  it("uses the mission-type override policy hints", () => {
    const plan = planDiscovery(intent({ missionTypeOverride: "DOCUMENTATION" }));
    expect(plan.missionType).toBe("DOCUMENTATION");
    expect(plan.batches[0]?.query.labels).toContain("documentation");
  });

  it("prefers the explicit language", () => {
    const plan = planDiscovery(intent({ languages: ["typescript"] }));
    expect(plan.batches[0]?.query.language).toBe("typescript");
  });

  it("bounds the page and enrichment budgets", () => {
    const plan = planDiscovery(intent({ pageBudget: 100 }));
    expect(plan.batches[0]?.pageBudget).toBe(5);
    expect(plan.enrichmentBudget).toBe(3);
  });

  it("carries excluded prior candidates", () => {
    const plan = planDiscovery(intent({ exclusions: ["c1", "c2"] }));
    expect(plan.excludedIds).toEqual(["c1", "c2"]);
  });
});
