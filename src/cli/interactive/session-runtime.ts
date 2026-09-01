import type { CommandContext, CommandHandlers } from "../command-handlers.js";
import type { ViewModel } from "../presentation/view-models.js";
import type { SessionEvent } from "./session-state.js";

/**
 * Hard deadline for the mount-time `auth status` check. When the startup
 * auth check exceeds this timeout, the runtime dispatches `AUTH_FAILED`
 * with `errorCode: "STARTUP_AUTH_TIMEOUT"` so the reducer transitions to
 * `unknown`. The deadline is fixed: a flaky network must never strand the
 * session on a permanent "Checking GitHub…" placeholder.
 */
export const STARTUP_AUTH_TIMEOUT_MS = 5_000;

/** A Node-style timer handle. Named so consumers don't reach for `ReturnType`. */
export type TimeoutHandle = ReturnType<typeof setTimeout>;

/**
 * Bridge a parent signal (process lifetime) to a single child controller
 * whose signal is used as the per-command abort surface. The child aborts
 * when the parent aborts (process shutdown) and can be disposed so a new
 * command can install its own child without leaking the listener.
 *
 * The child does NOT abort when the command completes — `dispose()` is
 * the only cleanup the runtime needs to call. The `signal` stays usable
 * for the duration of the operation; passing it to handlers is fine.
 */
export function createChildOperation(parent: AbortSignal): {
  readonly controller: AbortController;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  const abort = (): void => controller.abort(parent.reason);
  parent.addEventListener("abort", abort, { once: true });
  if (parent.aborted) abort();
  return {
    controller,
    dispose: () => parent.removeEventListener("abort", abort),
  };
}

interface RunStartupAuthInput {
  readonly handlers: CommandHandlers;
  readonly parentSignal: AbortSignal;
  readonly attemptId: number;
  readonly dispatch: (event: SessionEvent) => void;
}

/**
 * Race the mount-time `auth status` handler against a 5-second deadline.
 *
 * The runtime never blocks first render: the caller awaits the returned
 * promise only to keep the contract honest in tests. The reducer-owned
 * `dispatch` is the authoritative sink for the auth transition.
 *
 * Outcomes (exactly one per attempt):
 * - handler wins → `AUTH_RESOLVED` with the connected/NOT_CONNECTED/EXPIRED detail.
 * - deadline wins → `AUTH_FAILED` with `errorCode: "STARTUP_AUTH_TIMEOUT"` and
 *   the child signal aborted so handler-side cleanup can run.
 * - handler rejects → `AUTH_FAILED` with the rejected error's `code`, or
 *   `UNKNOWN` when the error carries no code.
 * - parent aborts → the child signal aborts and NO `AUTH_FAILED` is
 *   dispatched (the session is unmounting; a spurious auth transition is
 *   a worse outcome than letting the reducer stay on `checking`).
 *
 * A late handler settlement after the deadline is suppressed so a
 * previously-pending response can never overwrite the timeout transition.
 * The returned promise settles when the deadline fires, even if the
 * handler's promise never resolves (a flaky handler that ignores abort).
 */
export function runStartupAuth(input: RunStartupAuthInput): Promise<void> {
  const { handlers, parentSignal, attemptId, dispatch } = input;
  const child = createChildOperation(parentSignal);

  return new Promise<void>((resolve) => {
    let settled = false;
    let deadlineHandle: TimeoutHandle | undefined;

    const finalize = (action: () => void): void => {
      if (settled) return;
      settled = true;
      if (deadlineHandle !== undefined) {
        clearTimeout(deadlineHandle);
        deadlineHandle = undefined;
      }
      parentSignal.removeEventListener("abort", onParentAbort);
      child.dispose();
      action();
      resolve();
    };

    const handleAuthStatusView = (view: ViewModel): void => {
      if (view.kind === "auth-status") {
        if (view.connected && view.login !== null) {
          finalize(() =>
            dispatch({
              type: "AUTH_RESOLVED",
              attemptId,
              detail: "CONNECTED",
              login: view.login,
            }),
          );
          return;
        }
        if (view.detail === "EXPIRED") {
          finalize(() =>
            dispatch({
              type: "AUTH_RESOLVED",
              attemptId,
              detail: "EXPIRED",
              login: null,
            }),
          );
          return;
        }
        if (view.detail === "NOT_CONNECTED" || view.detail === "LOGGED_OUT") {
          finalize(() =>
            dispatch({
              type: "AUTH_RESOLVED",
              attemptId,
              detail: "NOT_CONNECTED",
              login: null,
            }),
          );
          return;
        }
      }
      // Any non-auth-status shape is unexpected from /auth status; treat as
      // an unknown failure so the reducer still transitions off `checking`.
      finalize(() =>
        dispatch({
          type: "AUTH_FAILED",
          attemptId,
          errorCode: "UNKNOWN",
        }),
      );
    };

    const handleReject = (error: unknown): void => {
      const code = readErrorCode(error);
      finalize(() =>
        dispatch({
          type: "AUTH_FAILED",
          attemptId,
          errorCode: code,
        }),
      );
    };

    const handleDeadline = (): void => {
      // Abort the child so any handler-side abort listeners / cleanup can
      // unwind. The deadline-wins path then dispatches the timeout failure.
      child.controller.abort(new Error("STARTUP_AUTH_TIMEOUT"));
      finalize(() =>
        dispatch({
          type: "AUTH_FAILED",
          attemptId,
          errorCode: "STARTUP_AUTH_TIMEOUT",
        }),
      );
    };

    const onParentAbort = (): void => {
      // Parent abort: never dispatch AUTH_FAILED — the session is
      // tearing down and the reducer is about to be unmounted with it.
      finalize(() => undefined);
    };

    parentSignal.addEventListener("abort", onParentAbort, { once: true });

    handlers
      .authStatus({}, { signal: child.controller.signal } satisfies CommandContext)
      .then(handleAuthStatusView, handleReject)
      .catch(() => {
        // `then(handleAuthStatusView, handleReject)` already converts
        // rejection to `handleReject`, but a synchronous throw from the
        // dispatcher must not escape the runtime. The outer promise
        // resolves through `finalize`; this catch only swallows
        // late-arriving rejections.
      });

    deadlineHandle = setTimeout(handleDeadline, STARTUP_AUTH_TIMEOUT_MS);
  });
}

/**
 * Read the `code` field from an unknown error without inline-cast access.
 * Returns "UNKNOWN" when the error carries no string-typed code.
 */
function readErrorCode(error: unknown): string {
  if (error instanceof Error && "code" in error) {
    const code = error.code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  if (error !== null && typeof error === "object" && "code" in error) {
    const record = error as Record<"code", unknown>;
    if (typeof record.code === "string" && record.code.length > 0) {
      return record.code;
    }
  }
  return "UNKNOWN";
}