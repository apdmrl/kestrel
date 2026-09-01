import type { CommandContext, CommandHandlers } from "../command-handlers.js";
import { errorViewModel } from "../presentation/view-models.js";
import { renderPlain } from "../presentation/plain-renderer.js";
import type { SessionCommand } from "./session-parser.js";

export type SessionControllerResult =
  | { readonly kind: "output"; readonly text: string }
  | { readonly kind: "clear" }
  | { readonly kind: "exit" }
  | { readonly kind: "error"; readonly text: string };

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
 */
export function createSessionController(
  handlers: CommandHandlers,
  notify?: (text: string) => void,
): (command: SessionCommand, context: CommandContext) => Promise<SessionControllerResult> {
  return async (command, context) => {
    if (command.kind === "help") {
      return {
        kind: "output",
        text: "/help  /clear  /exit\n/auth login  /auth status  /auth logout --confirm github.com\n/find  /mission current  /mission ...\n/progress  /journey  /preferences ...",
      };
    }
    if (command.kind === "clear") return { kind: "clear" };
    if (command.kind === "exit") return { kind: "exit" };

    // The interactive session places notices into the transcript via its
    // notify channel; the controller owns the context.onNotice wiring so the
    // session doesn't have to know which handler invoked the notice.
    const authLoginContext: CommandContext = {
      ...context,
      onNotice: (view) => {
        notify?.(renderPlain(view));
      },
    };

    try {
      let view;
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
            {
              mood: command.mood,
              ...(command.type !== undefined ? { type: command.type } : {}),
            },
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
      return { kind: "output", text: renderPlain(view) };
    } catch (error) {
      return { kind: "error", text: renderPlain(errorViewModel(error)) };
    }
  };
}