import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { render } from "ink";
import { createElement } from "react";
import { bootstrap, createConfig } from "../bootstrap/index.js";
import { shouldOpenBrowser } from "../application/auth/browser-launch-policy.js";
import type { CommandHandlers } from "./command-handlers.js";
import { createProgram } from "./create-program.js";
import { Session } from "./interactive/session.js";
import { createAtomicTerminalSession } from "./presentation/atomic-terminal-session.js";
import { shouldStartSession } from "./session-start.js";

export interface InteractiveSessionOptions {
  readonly handlers: CommandHandlers;
  readonly signal: AbortSignal;
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly render?: typeof render;
  readonly onCleanup?: (cleanup: (() => void) | undefined) => void;
}

export async function runInteractiveSession(options: InteractiveSessionOptions): Promise<void> {
  const stdin = options.stdin ?? process.stdin;
  const terminal = createAtomicTerminalSession({
    stdin,
    stdout: options.stdout ?? process.stdout,
  });
  options.onCleanup?.(terminal.cleanup);
  let closeOnAbort: (() => void) | undefined;
  try {
    const app = (options.render ?? render)(
      createElement(Session, {
        handlers: options.handlers,
        signal: options.signal,
      }),
      { exitOnCtrlC: false, stdin, stdout: terminal.stdout },
    );
    closeOnAbort = (): void => app.unmount();
    options.signal.addEventListener("abort", closeOnAbort, { once: true });
    if (options.signal.aborted) closeOnAbort();
    await app.waitUntilExit();
  } finally {
    if (closeOnAbort !== undefined) {
      options.signal.removeEventListener("abort", closeOnAbort);
    }
    terminal.cleanup();
    options.onCleanup?.(undefined);
  }
}

export function createSignalHandler(options: {
  readonly controller: AbortController;
  readonly getActiveSessionCleanup: () => (() => void) | undefined;
  readonly exit: (code: number) => void;
}): () => void {
  let forced = false;
  return () => {
    if (forced) {
      options.getActiveSessionCleanup()?.();
      options.exit(130);
      return;
    }
    forced = true;
    options.controller.abort();
  };
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const config = createConfig(process.env as Record<string, string | undefined>);
  // Wire the commander --no-interactive flag into bootstrap before handlers run.
  // `--json` is a hard override: machine-mode output never begins device
  // flow (it has no place to write the verification URI or user code, and
  // it would block the machine caller on a manual browser step). Spec
  // §10 requires `--json` to suppress browser/device flow; we extend that
  // to interactive prompts too.
  const json = args.includes("--json");
  const interactive = !args.includes("--no-interactive") && !json;
  // The browser launch decision is a policy, not a presentation concern, so it
  const openBrowser = shouldOpenBrowser({
    noBrowserFlag: args.includes("--no-browser"),
    envDisabled: config.noBrowser,
    json: args.includes("--json"),
    interactive,
  });
  // The exact `mission break-lock` invocation must run before journal replay so
  // a stale lock that replay would trip over can be cleared first.
  const isBreakLock = ((): boolean => {
    const positional = args.filter((a) => !a.startsWith("-"));
    return positional[0] === "mission" && positional[1] === "break-lock";
  })();
  // Shared cancellation contract: SIGINT/SIGTERM abort the operation so it can
  // unwind gracefully (releasing locks, preserving resumable state). A second
  // signal forces an immediate exit for commands that do not observe the abort.
  const controller = new AbortController();
  let activeSessionCleanup: (() => void) | undefined;
  const onSignal = createSignalHandler({
    controller,
    getActiveSessionCleanup: () => activeSessionCleanup,
    exit: (code) => process.exit(code),
  });
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  // Bootstrap is signal-free in Task 2: every handler now reads its
  // AbortSignal from per-invocation CommandContext. The process-lifetime
  // signal is threaded only into the entry surfaces below.
  const handlers = await bootstrap(config, {
    interactive,
    openBrowser,
    recover: !isBreakLock,
  });
  try {
    if (shouldStartSession(args)) {
      await runInteractiveSession({
        handlers,
        signal: controller.signal,
        onCleanup: (cleanup) => {
          activeSessionCleanup = cleanup;
        },
      });
    } else {
      const program = createProgram({ handlers, signal: controller.signal });
      await program.parseAsync(process.argv);
    }
  } catch (error) {
    // createProgram enables exitOverride, so Commander never calls
    // process.exit directly: it has already written the message and help to
    // stderr through the configured channel. Propagate its exit code.
    const exitCode = (error as { exitCode?: unknown }).exitCode;
    process.exitCode = typeof exitCode === "number" ? exitCode : 1;
  }
  // After a first SIGINT/SIGTERM the operation has unwound (locks released,
  // resumable state preserved). Force a prompt exit so a background poll (e.g.
  // device flow) cannot keep the process alive; a second signal already forced
  // an immediate exit in the handler.
  //
  // The commit point is journal intent creation: a signal observed after that
  // point means a durable transaction finished and was committed, so the
  // process must NOT be forced to exit 130 for an ordinary success. We only
  // force-exit on a classified error path (process.exitCode was set, e.g. to
  // 130 for a cancellation) and never overwrite a completed mutation's 0.
  if (controller.signal.aborted && process.exitCode !== undefined) {
    process.exit(process.exitCode);
  }
}

export function isExecutableEntrypoint(argvEntry: string | undefined, moduleUrl: string): boolean {
  if (argvEntry === undefined) return false;
  try {
    return realpathSync(argvEntry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isExecutableEntrypoint(process.argv[1], import.meta.url)) {
  void main();
}