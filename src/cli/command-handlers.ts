import type { DeviceAuthorizationViewModel, ViewModel } from "./presentation/view-models.js";

/** Application boundaries the CLI commands call; composed in bootstrap. */
export interface CommandHandlers {
  readonly find: (args: { mood: string; type?: string }) => Promise<ViewModel>;
  /**
   * Authenticate with GitHub.
   *
   * Device-flow guidance is delivered through `onDeviceAuthorization` rather
   * than written directly, so each presentation can place it correctly: the
   * one-shot CLI renders it to stderr, while the Ink session appends it to the
   * transcript instead of corrupting the frame with a raw write.
   */
  readonly authLogin: (args: {
    onDeviceAuthorization?: (view: DeviceAuthorizationViewModel) => void;
  }) => Promise<ViewModel>;
  readonly authStatus: () => Promise<ViewModel>;
  readonly authLogout: (args: { confirmation?: string }) => Promise<ViewModel>;
  readonly missionAccept: (args: { recommendationId: string }) => Promise<ViewModel>;
  readonly missionPrepare: (args: { missionId?: string }) => Promise<ViewModel>;
  readonly missionResume: (args: { missionId?: string }) => Promise<ViewModel>;
  readonly missionCurrent: (args?: { missionId?: string }) => Promise<ViewModel>;
  readonly missionComplete: (args: { missionId?: string }) => Promise<ViewModel>;
  readonly missionBreakLock: (args: { missionId: string }) => Promise<ViewModel>;
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
