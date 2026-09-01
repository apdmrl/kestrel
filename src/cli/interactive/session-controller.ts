import type { CommandContext, CommandHandlers } from "../command-handlers.js";
import { errorViewModel } from "../presentation/view-models.js";
import { renderPlain } from "../presentation/plain-renderer.js";
import type { ViewModel } from "../presentation/view-models.js";
import type { SessionCommand } from "./session-parser.js";

export type SessionControllerResult =
  | { readonly kind: "output"; readonly view: ViewModel; readonly text: string }
  | { readonly kind: "clear" }
  | { readonly kind: "exit" }
  | { readonly kind: "error"; readonly view: ViewModel; readonly text: string };

/**
 * Build the session command router.
 *
 * `notify` receives interim guidance that arrives while a command is still
 * running, such as device-flow instructions. The session appends it to the
 * transcript; writing it directly to stderr would corrupt the Ink frame.
 *
 * The returned callback accepts an explicit `CommandContext` for each parsed
 * command so the session runtime owns the per-command signal lifecycle and
 * can interrupt a single operation without aborting the whole session.
 *
 * Controller results carry both the raw `ViewModel` and a plain-rendered
 * `text` snapshot. The interactive session can route them through
 * `renderSessionView` (preferred for auth/error/device recovery) or fall
 * back to the pre-rendered text. The one-shot CLI keeps using `renderPlain`
 * directly. Interim notices also carry a `ViewModel`.
 */
export function createSessionController(
  handlers: CommandHandlers,
  notify?: (view: ViewModel) => void,
): (command: SessionCommand, context: CommandContext) => Promise<SessionControllerResult> {
  return async (command, context) => {
    if (command.kind === "help") {
      const view: ViewModel = {
        kind: "verification",
        text: "/help  /clear  /exit\n/auth login  /auth status  /auth logout --confirm github.com\n/find  /mission current  /mission ...\n/progress  /journey  /preferences ...",
      };
      return { kind: "output", view, text: renderPlain(view) };
    }
    if (command.kind === "clear") return { kind: "clear" };
    if (command.kind === "exit") return { kind: "exit" };

    const authLoginContext: CommandContext = {
      ...context,
      onNotice: (view) => {
        notify?.(view);
      },
    };

    let view: ViewModel;
    try {
      switch (command.kind) {
        case "auth-login":
          view = await handlers.authLogin({}, authLoginContext);
          break;
        case "auth-status":
          view = await handlers.authStatus({}, context);
          break;
        case "auth-logout":
          view = await handlers.authLogout(
            command.confirmation === undefined ? {} : { confirmation: command.confirmation },
            context,
          );
          break;
        case "find":
          view = await handlers.find(
            { mood: command.mood, ...(command.type !== undefined ? { type: command.type } : {}) },
            context,
          );
          break;
        case "mission-current":
          view = await handlers.missionCurrent(
            command.missionId === undefined ? {} : { missionId: command.missionId },
            context,
          );
          break;
        case "mission-accept":
          view = await handlers.missionAccept({ recommendationId: command.recommendationId }, context);
          break;
        case "mission-prepare":
          view = await handlers.missionPrepare(
            command.missionId === undefined ? {} : { missionId: command.missionId },
            context,
          );
          break;
        case "mission-resume":
          view = await handlers.missionResume(
            command.missionId === undefined ? {} : { missionId: command.missionId },
            context,
          );
          break;
        case "mission-complete":
          view = await handlers.missionComplete(
            command.missionId === undefined ? {} : { missionId: command.missionId },
            context,
          );
          break;
        case "mission-abandon":
          view = await handlers.missionAbandon(
            {
              reason: command.reason,
              ...(command.missionId !== undefined ? { missionId: command.missionId } : {}),
            },
            context,
          );
          break;
        case "mission-break-lock":
          view = await handlers.missionBreakLock({ missionId: command.missionId }, context);
          break;
        case "agent-brief":
          view = await handlers.agentBrief(
            {
              ...(command.missionId !== undefined ? { missionId: command.missionId } : {}),
              ...(command.hypothesis !== undefined ? { hypothesis: command.hypothesis } : {}),
            },
            context,
          );
          break;
        case "verify-submission":
          view = await handlers.verifySubmission(
            {
              prNumber: command.prNumber,
              ...(command.missionId !== undefined ? { missionId: command.missionId } : {}),
            },
            context,
          );
          break;
        case "verify-link":
          view = await handlers.verifyLink(
            {
              prNumber: command.prNumber,
              ...(command.missionId !== undefined ? { missionId: command.missionId } : {}),
            },
            context,
          );
          break;
        case "verify-merge":
          view = await handlers.verifyMerge(
            {
              prNumber: command.prNumber,
              ...(command.missionId !== undefined ? { missionId: command.missionId } : {}),
            },
            context,
          );
          break;
        case "journey":
          view = await handlers.journey({}, context);
          break;
        case "progress":
          view = await handlers.progress({}, context);
          break;
        case "preferences-get":
          view = await handlers.preferencesGet({}, context);
          break;
        case "preferences-set":
          view = await handlers.preferencesSet(
            {
              ...(command.language !== undefined ? { language: command.language } : {}),
              ...(command.mode !== undefined ? { mode: command.mode } : {}),
            },
            context,
          );
          break;
      }
      return { kind: "output", view, text: renderPlain(view) };
    } catch (error) {
      const errorView = errorViewModel(error);
      return { kind: "error", view: errorView, text: renderPlain(errorView) };
    }
  };
}