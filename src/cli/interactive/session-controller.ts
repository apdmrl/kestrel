import type { CommandContext, CommandHandlers } from "../command-handlers.js";
import { errorViewModel } from "../presentation/view-models.js";
import type { ViewModel } from "../presentation/view-models.js";
import type { SessionCommand } from "./session-parser.js";

export type SessionControllerResult =
  | { readonly kind: "output"; readonly view: ViewModel }
  | { readonly kind: "clear" }
  | { readonly kind: "exit" }
  | { readonly kind: "error"; readonly view: ViewModel };

/**
 * Build the session command router.
 *
 * `notify` receives interim guidance that arrives while a command is still
 * running, such as device-flow instructions. The session appends it to the
 * transcript through `renderSessionView`; writing it directly to stderr would
 * corrupt the Ink frame.
 *
 * The returned callback accepts an explicit `CommandContext` for each parsed
 * command so the session runtime owns the per-command signal lifecycle and
 * can interrupt a single operation without aborting the whole session.
 *
 * Controller results carry only the raw `ViewModel` for output and error
 * variants. The session renders those view models through `renderSessionView`
 * so error/auth/device paths use interactive slash-command recovery instead
 * of shell-style `kestrel auth login` text. The one-shot CLI keeps using
 * `renderPlain` directly on the same view model. Interim notices also carry
 * a `ViewModel`.
 */
export function createSessionController(
  handlers: CommandHandlers,
  notify?: (view: ViewModel) => void,
): (command: SessionCommand, context: CommandContext) => Promise<SessionControllerResult> {
  return async (command, context) => {
    if (command.kind === "help") {
      const view: ViewModel = {
        kind: "verification",
        text: "/help\n/clear\n/exit\n/auth login\n/auth status\n/auth logout --confirm github.com\n/find\n/mission current\n/mission ...\n/progress\n/journey\n/preferences ...",
      };
      return { kind: "output", view };
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
          view = await handlers.missionAccept(
            { recommendationId: command.recommendationId },
            context,
          );
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
      return { kind: "output", view };
    } catch (error) {
      const errorView = errorViewModel(error);
      return { kind: "error", view: errorView };
    }
  };
}
