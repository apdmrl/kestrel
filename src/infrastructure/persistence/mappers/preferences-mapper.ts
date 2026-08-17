import type { ExplicitPreferences } from "../../../domain/preferences/preferences.js";
import { createExplicitPreferences } from "../../../domain/preferences/preferences.js";
import type { DomainResult } from "../../../domain/shared/result.js";
import { err } from "../../../domain/shared/result.js";
import { checkSchemaVersion } from "../schema-version.js";
import { preferencesSchema, type PersistedPreferences } from "../schemas/preferences-schema.js";

export function toPersistedPreferences(preferences: ExplicitPreferences): PersistedPreferences {
  return {
    schemaVersion: 1,
    preferredLanguages: [...preferences.preferredLanguages],
    preferredDifficulty: preferences.preferredDifficulty ?? null,
    defaultMode: preferences.defaultMode,
    workspaceRoot: preferences.workspaceRoot ?? null,
  };
}

export function fromPersistedPreferences(data: unknown): DomainResult<ExplicitPreferences> {
  const version = checkSchemaVersion(data);
  if (!version.ok) {
    return version;
  }
  const parsed = preferencesSchema.safeParse(data);
  if (!parsed.success) {
    return err("DM_STATE_CORRUPTED", "preferences state failed schema validation");
  }
  return createExplicitPreferences({
    preferredLanguages: parsed.data.preferredLanguages,
    ...(parsed.data.preferredDifficulty !== null
      ? { preferredDifficulty: parsed.data.preferredDifficulty }
      : {}),
    defaultMode: parsed.data.defaultMode,
    ...(parsed.data.workspaceRoot !== null ? { workspaceRoot: parsed.data.workspaceRoot } : {}),
  });
}
