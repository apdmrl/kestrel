import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { createKestrelError } from "../../application/errors/kestrel-error.js";
import type { ExplicitPreferences } from "../../domain/preferences/preferences.js";
import type { PreferencesStore, StoredPreferences } from "../../ports/preferences-store.js";
import { readValidatedJson, writeJsonAtomically } from "../fs/atomic-json-file.js";
import { fromPersistedPreferences, toPersistedPreferences } from "./mappers/preferences-mapper.js";
import { preferencesSchema } from "./schemas/preferences-schema.js";

const storedPreferencesSchema = z.object({
  schemaVersion: z.literal(1),
  stateVersion: z.number().int().min(0),
  preferences: preferencesSchema,
});

type StoredPreferencesFile = z.infer<typeof storedPreferencesSchema>;

function conflictError() {
  return createKestrelError({
    code: "DM_STORE_CONFLICT",
    category: "CONFLICT",
    userMessage: "Preferences changed since they were read",
    suggestedActions: ["Reload preferences and retry"],
    retryability: "NO_RETRY",
    recoveryStrategy: "USER_ACTION",
    severity: "ERROR",
  });
}

export class FileSystemPreferencesStore implements PreferencesStore {
  constructor(private readonly filePath: string) {}

  async get(): Promise<StoredPreferences | undefined> {
    const envelope = await readValidatedJson(this.filePath, storedPreferencesSchema);
    if (envelope === undefined) {
      return undefined;
    }
    const preferences = fromPersistedPreferences(envelope.preferences);
    if (!preferences.ok) {
      throw createKestrelError({
        code: "DM_STATE_CORRUPTED",
        category: "RECOVERABLE_STATE",
        userMessage: "Persisted preferences are invalid",
        suggestedActions: ["Restore from the automatic backup, or remove the corrupt file"],
        retryability: "NO_RETRY",
        recoveryStrategy: "MANUAL_INTERVENTION",
        severity: "ERROR",
        cause: preferences.error,
      });
    }
    return { preferences: preferences.value, version: envelope.stateVersion };
  }

  async save(
    preferences: ExplicitPreferences,
    expectedVersion: number,
  ): Promise<StoredPreferences> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const current = await readValidatedJson(this.filePath, storedPreferencesSchema);
    const currentVersion = current?.stateVersion ?? 0;
    if (currentVersion !== expectedVersion) {
      throw conflictError();
    }
    const envelope: StoredPreferencesFile = {
      schemaVersion: 1,
      stateVersion: expectedVersion + 1,
      preferences: toPersistedPreferences(preferences),
    };
    await writeJsonAtomically(this.filePath, envelope, storedPreferencesSchema);
    return { preferences, version: expectedVersion + 1 };
  }
}
