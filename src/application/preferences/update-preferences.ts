import type { ExplicitPreferences } from "../../domain/preferences/preferences.js";
import type { PreferencesStore } from "../../ports/preferences-store.js";

export interface UpdatePreferencesDeps {
  readonly preferencesStore: PreferencesStore;
}

export interface UpdatePreferencesInput {
  readonly preferences: ExplicitPreferences;
  readonly expectedVersion: number;
}

export async function updatePreferences(
  deps: UpdatePreferencesDeps,
  input: UpdatePreferencesInput,
): Promise<ExplicitPreferences> {
  const stored = await deps.preferencesStore.save(input.preferences, input.expectedVersion);
  return stored.preferences;
}
