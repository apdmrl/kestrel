import type { ViewModel } from "./presentation/view-models.js";

/** Application boundaries the CLI commands call; composed in bootstrap. */
export interface CommandHandlers {
  readonly find: (args: { mood: string; type?: string }) => Promise<ViewModel>;
  readonly missionAccept: (args: Record<string, never>) => Promise<ViewModel>;
  readonly missionPrepare: (args: { missionId?: string }) => Promise<ViewModel>;
  readonly missionResume: (args: { missionId?: string }) => Promise<ViewModel>;
  readonly missionCurrent: (args?: { missionId?: string }) => Promise<ViewModel>;
  readonly missionComplete: (args: { missionId?: string }) => Promise<ViewModel>;
  readonly missionAbandon: (args: { missionId?: string; reason: string }) => Promise<ViewModel>;
  readonly agentBrief: (args: { missionId?: string; hypothesis?: string }) => Promise<ViewModel>;
  readonly verifySubmission: (args: { missionId?: string; prNumber: number }) => Promise<ViewModel>;
  readonly verifyLink: (args: { missionId?: string; prNumber: number }) => Promise<ViewModel>;
  readonly verifyMerge: (args: { missionId?: string; prNumber: number }) => Promise<ViewModel>;
  readonly journey: () => Promise<ViewModel>;
  readonly progress: () => Promise<ViewModel>;
  readonly preferencesGet: () => Promise<ViewModel>;
  readonly preferencesSet: (args: { language?: string; mode?: string }) => Promise<ViewModel>;
}
