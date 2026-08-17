import { describe, expect, it } from "vitest";
import {
  createExplicitPreferences,
  resolveDeveloperContext,
  type DeveloperMode,
  type Difficulty,
} from "./preferences.js";
import { createLearnedSignals } from "./learned-signals.js";

describe("ExplicitPreferences", () => {
  it("applies sensible defaults", () => {
    const result = createExplicitPreferences({});
    expect(result).toEqual({
      ok: true,
      value: {
        preferredLanguages: [],
        preferredDifficulty: undefined,
        defaultMode: "GUIDED",
        workspaceRoot: undefined,
      },
    });
  });

  it("deduplicates and trims preferred languages", () => {
    const result = createExplicitPreferences({
      preferredLanguages: ["typescript", " typescript ", "", "Python"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.preferredLanguages).toEqual(["typescript", "Python"]);
    }
  });

  it("preserves an explicit difficulty and mode", () => {
    const result = createExplicitPreferences({
      preferredDifficulty: "INTERMEDIATE" as Difficulty,
      defaultMode: "EXPERT" as DeveloperMode,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.preferredDifficulty).toBe("INTERMEDIATE");
      expect(result.value.defaultMode).toBe("EXPERT");
    }
  });
});

describe("resolveDeveloperContext", () => {
  it("lets an explicit language override a stronger learned affinity", () => {
    const explicit = createExplicitPreferences({
      preferredLanguages: ["typescript"],
      defaultMode: "EXPERT" as DeveloperMode,
    });
    const learned = createLearnedSignals({
      languageAffinity: { python: 0.9, typescript: 0.1 },
      missionTypeAffinity: { BUG_FIX: 0.7, TESTING: 0.2, DOCUMENTATION: 0.1 },
    });
    if (!explicit.ok || !learned.ok) {
      throw new Error("expected ok");
    }
    const context = resolveDeveloperContext(explicit.value, learned.value);
    expect(context.preferredLanguages).toEqual(["typescript"]);
    expect(context.languageAffinity).toEqual({ python: 0.9, typescript: 0.1 });
    expect(context.mode).toBe("EXPERT");
  });
});
