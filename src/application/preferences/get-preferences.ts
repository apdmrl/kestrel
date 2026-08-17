import type { ExplicitPreferences } from "../../domain/preferences/preferences.js";
import { createExplicitPreferences } from "../../domain/preferences/preferences.js";
import { createLearnedSignals } from "../../domain/preferences/learned-signals.js";
import type { LearnedSignals } from "../../domain/preferences/learned-signals.js";
import type { JourneyEvent } from "../../domain/journey/journey-event.js";
import type { JourneyStore } from "../../ports/journey-store.js";
import type { PreferencesStore } from "../../ports/preferences-store.js";

export interface GetPreferencesDeps {
  readonly preferencesStore: PreferencesStore;
  readonly journeyStore: JourneyStore;
}

export interface GetPreferencesResult {
  readonly explicit: ExplicitPreferences;
  readonly learned: LearnedSignals;
  readonly version: number;
}

export async function getPreferences(deps: GetPreferencesDeps): Promise<GetPreferencesResult> {
  const stored = await deps.preferencesStore.get();
  const explicit =
    stored?.preferences ??
    (createExplicitPreferences({}).ok
      ? (createExplicitPreferences({}) as { value: ExplicitPreferences }).value
      : ({} as ExplicitPreferences));
  const version = stored?.version ?? 0;
  // Learned signals are rebuilt from Journey behavior by the caller/projector.
  const events: JourneyEvent[] = await deps.journeyStore.readAll();
  void events;
  const empty = createLearnedSignals({});
  const learned = empty.ok
    ? empty.value
    : ({
        languageAffinity: {},
        missionTypeAffinity: { BUG_FIX: 0, TESTING: 0, DOCUMENTATION: 0 },
        interestAffinity: {},
        scopeAffinity: {},
        recentPatterns: [],
      } as LearnedSignals);
  return { explicit, learned, version };
}
