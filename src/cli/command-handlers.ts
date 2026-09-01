import type { ViewModel } from "./presentation/view-models.js";

/**
 * Per-invocation operation context that travels with every command handler.
 *
 * `signal` aborts cancellation-aware operations gracefully (releases locks,
 * preserves resumable state) and is supplied by the composition root. The
 * process-lifetime signal lives at the process edge, not at bootstrap.
 *
 * `onNotice` carries interim guidance such as device-flow instructions and
 * the result of a browser launch so each presentation can place it correctly:
 * the one-shot CLI renders it to stderr while the Ink session appends it to
 * the transcript instead of corrupting the frame with a raw write.
 */
export interface CommandContext {
  readonly signal?: AbortSignal;
  readonly onNotice?: (view: ViewModel) => void;
}

type Handler<Args> = (args: Args, context: CommandContext) => Promise<ViewModel>;

/** Application boundaries the CLI commands call; composed in bootstrap. */
export interface CommandHandlers {
  readonly find: Handler<{ readonly mood: string; readonly type?: string }>;
  readonly authLogin: Handler<Record<string, never>>;
  readonly authStatus: Handler<Record<string, never>>;
  readonly authLogout: Handler<{ readonly confirmation?: string }>;
  readonly missionAccept: Handler<{ readonly recommendationId: string }>;
  readonly missionPrepare: Handler<{ readonly missionId?: string }>;
  readonly missionResume: Handler<{ readonly missionId?: string }>;
  readonly missionCurrent: Handler<{ readonly missionId?: string }>;
  readonly missionComplete: Handler<{ readonly missionId?: string }>;
  readonly missionBreakLock: Handler<{ readonly missionId: string }>;
  readonly missionAbandon: Handler<{ readonly missionId?: string; readonly reason: string }>;
  readonly agentBrief: Handler<{ readonly missionId?: string; readonly hypothesis?: string }>;
  readonly verifySubmission: Handler<{ readonly missionId?: string; readonly prNumber: number }>;
  readonly verifyLink: Handler<{ readonly missionId?: string; readonly prNumber: number }>;
  readonly verifyMerge: Handler<{ readonly missionId?: string; readonly prNumber: number }>;
  readonly journey: Handler<Record<string, never>>;
  readonly progress: Handler<Record<string, never>>;
  readonly preferencesGet: Handler<Record<string, never>>;
  readonly preferencesSet: Handler<{ readonly language?: string; readonly mode?: string }>;
}