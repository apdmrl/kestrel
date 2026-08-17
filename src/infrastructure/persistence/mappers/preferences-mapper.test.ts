import { describe, expect, it } from "vitest";
import { createExplicitPreferences } from "../../../domain/preferences/preferences.js";
import { fromPersistedPreferences, toPersistedPreferences } from "./preferences-mapper.js";

describe("preferences mapper", () => {
  it("round-trips preferences", () => {
    const result = createExplicitPreferences({
      preferredLanguages: ["typescript", "Python"],
      preferredDifficulty: "INTERMEDIATE",
      defaultMode: "EXPERT",
      workspaceRoot: "/home/dev/kestrel",
    });
    if (!result.ok) {
      throw new Error("expected ok");
    }
    const persisted = toPersistedPreferences(result.value);
    expect(persisted.schemaVersion).toBe(1);

    const restored = fromPersistedPreferences(persisted);
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(toPersistedPreferences(restored.value)).toEqual(persisted);
    }
  });

  it("rejects an unknown future schema version", () => {
    const created = createExplicitPreferences({});
    if (!created.ok) {
      throw new Error("expected ok");
    }
    const persisted = toPersistedPreferences(created.value);
    const result = fromPersistedPreferences({ ...persisted, schemaVersion: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("DM_STATE_VERSION_UNSUPPORTED");
    }
  });

  it("rejects malformed state", () => {
    expect(fromPersistedPreferences({ schemaVersion: 1, preferredLanguages: "nope" }).ok).toBe(
      false,
    );
    expect(fromPersistedPreferences(null).ok).toBe(false);
  });
});
