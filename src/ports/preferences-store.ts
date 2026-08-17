import type { ExplicitPreferences } from "../domain/preferences/preferences.js";

export interface StoredPreferences {
  readonly preferences: ExplicitPreferences;
  readonly version: number;
}

export interface PreferencesStore {
  get(): Promise<StoredPreferences | undefined>;
  save(preferences: ExplicitPreferences, expectedVersion: number): Promise<StoredPreferences>;
}
