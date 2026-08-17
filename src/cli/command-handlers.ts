import type { ViewModel } from "./presentation/view-models.js";

/** Application boundaries the CLI commands call; composed in bootstrap. */
export interface CommandHandlers {
  readonly find: (args: { mood: string; type?: string }) => Promise<ViewModel>;
  readonly missionCurrent: () => Promise<ViewModel>;
  readonly journey: () => Promise<ViewModel>;
  readonly progress: () => Promise<ViewModel>;
  readonly preferencesGet: () => Promise<ViewModel>;
  readonly preferencesSet: (args: { language?: string; mode?: string }) => Promise<ViewModel>;
}
