import type { ViewModel } from "../presentation/view-models.js";
import type { TranscriptMetadata } from "./session-view-models.js";
import { renderPlain } from "../presentation/plain-renderer.js";

/**
 * Interactive-specific rendering for view models that cross into the Ink
 * session. Only the fallback path delegates to `renderPlain`; auth-status,
 * error, and device-authorization views use slash-command recovery so the
 * prompt can fill the right action without a second Enter.
 *
 * Plain (`kestrel auth login`) and JSON renderers are unchanged. Shell- and
 * JSON-oriented recovery strings never appear inside the interactive renderer.
 *
 * Error handling keeps every `suggestedActions` entry: only the shell-style
 * `kestrel auth login` / `kestrel auth status` tokens are translated into
 * their slash equivalents, surrounding guidance is preserved verbatim. The
 * generated "Run /auth <verb> to continue." line is appended only when no
 * identical line already exists in the rendered output.
 */
export interface SessionRenderedView {
  readonly kind: "output" | "error";
  readonly text: string;
  readonly recoveryCommand?: string;
  /**
   * Optional semantic metadata. Only set when the source view model
   * carries typed fields the bounded transcript classifier needs
   * (currently: a `device-authorization` view). The session
   * propagates the metadata into the transcript entry so the
   * bounded window keeps the exact validation URI / user code,
   * not a host-specific text regex. The plain / JSON renderers
   * never read this field.
   */
  readonly metadata?: TranscriptMetadata;
}

const AUTH_LOGIN = "/auth login";
const AUTH_STATUS = "/auth status";

// Match shell-style `kestrel auth <verb>` tokens inside the suggestedActions
// guidance. Whitespace is permissive because use cases write the command
// differently ("kestrel auth login", "`kestrel auth login`", "kestrel  auth
//  login"). Capture the verb so the replacement keeps the surrounding text.
const SHELL_AUTH_COMMAND = /kestrel\s+auth\s+(login|status)/giu;

/**
 * Translate the shell-style auth command tokens inside a suggested action
 * string into their slash equivalents. The surrounding guidance is preserved
 * verbatim so users still see "to authenticate, then retry" etc.
 */
function translateShellAuthCommand(suggestion: string): string {
  return suggestion.replace(SHELL_AUTH_COMMAND, (_, verb: string) =>
    verb.toLowerCase() === "status" ? AUTH_STATUS : AUTH_LOGIN,
  );
}
function authStatusText(view: Extract<ViewModel, { kind: "auth-status" }>): SessionRenderedView {
  switch (view.detail) {
    case "NOT_CONNECTED":
      return {
        kind: "output",
        text: `GitHub is not connected. Run ${AUTH_LOGIN} to authenticate.`,
        recoveryCommand: AUTH_LOGIN,
      };
    case "EXPIRED":
      return {
        kind: "output",
        text: `GitHub authentication has expired. Run ${AUTH_LOGIN} to re-authenticate.`,
        recoveryCommand: AUTH_LOGIN,
      };
    case "LOGGED_OUT":
      return {
        kind: "output",
        text: `Logged out of GitHub. Run ${AUTH_LOGIN} to authenticate.`,
        recoveryCommand: AUTH_LOGIN,
      };
    case "CONNECTED":
      return {
        kind: "output",
        text: `Connected to GitHub as ${view.login ?? "(unknown)"}.`,
      };
  }
}

function authErrorToRecovery(
  view: Extract<ViewModel, { kind: "error" }>,
): string | undefined {
  switch (view.code) {
    case "DM_GITHUB_AUTH_REQUIRED":
      return view.suggestedActions.some((action) =>
        translateShellAuthCommand(action).includes(AUTH_LOGIN),
      )
        ? AUTH_LOGIN
        : undefined;
    case "DM_GITHUB_AUTH_EXPIRED":
      return AUTH_LOGIN;
    case "DM_GITHUB_AUTH_CANCELLED":
      return undefined;
    case "DM_NETWORK_UNAVAILABLE":
    case "DM_GITHUB_TIMEOUT":
    case "DM_GITHUB_VALIDATION":
    case "DM_GITHUB_RATE_LIMITED":
    case "DM_GITHUB_ABUSE_LIMIT":
      return AUTH_STATUS;
    default:
      return undefined;
  }
}
function renderSessionError(view: Extract<ViewModel, { kind: "error" }>): SessionRenderedView {
  if (view.code === "DM_GITHUB_AUTH_CANCELLED") {
    return { kind: "output", text: view.userMessage };
  }
  const recovery = authErrorToRecovery(view);
  const header = `Error [${view.code}]: ${view.userMessage}`;
  const lines: string[] = [header];
  // Track canonical lines (without a leading bullet) for each rendered
  // suggestedAction so the generated recovery line below can be deduped
  // against identical guidance regardless of bullet prefix.
  const renderedCanonical = new Set<string>([header]);
  // Translate shell-style auth tokens in every suggested action into the
  // slash equivalent, then keep the surrounding guidance verbatim. No
  // guidance is dropped just because it carries the shell command.
  for (const action of view.suggestedActions) {
    const translated = translateShellAuthCommand(action);
    lines.push(`- ${translated}`);
    renderedCanonical.add(translated);
  }
  // Append the recovery line only when the suggestedActions did not already
  // cover it with an identical line. Two unique pieces of guidance are never
  // collapsed; only literal duplicates are deduped.
  if (recovery !== undefined) {
    const recoveryLine = `Run ${recovery} to continue.`;
    if (!renderedCanonical.has(recoveryLine)) {
      lines.push(recoveryLine);
    }
  }
  return {
    kind: "error",
    text: lines.join("\n"),
    ...(recovery === undefined ? {} : { recoveryCommand: recovery }),
  };
}
function renderDeviceAuthorization(
  view: Extract<ViewModel, { kind: "device-authorization" }>,
): SessionRenderedView {
  return {
    kind: "output",
    text: `Open ${view.verificationUri} and enter ${view.userCode}`,
    recoveryCommand: AUTH_LOGIN,
    metadata: {
      kind: "device-authorization",
      verificationUri: view.verificationUri,
      userCode: view.userCode,
    },
  };
}
/**
 * Convert a view model into the textual shape the session transcript expects.
 * Errors render as `error` entries (red action-required cards) unless the
 * classifier reports them as informational; the only informational exception
 * today is `DM_GITHUB_AUTH_CANCELLED`, which renders as a neutral `output`
 * notice because login cancellation keeps the session alive.
 */
export function renderSessionView(view: ViewModel): SessionRenderedView {
  if (view.kind === "error") return renderSessionError(view);
  if (view.kind === "auth-status") return authStatusText(view);
  if (view.kind === "device-authorization") return renderDeviceAuthorization(view);
  return { kind: "output", text: renderPlain(view) };
}