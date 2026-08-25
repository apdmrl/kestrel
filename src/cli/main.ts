#!/usr/bin/env node
import { render, type Instance } from "ink";
import { createElement } from "react";
import { bootstrap, createConfig } from "../bootstrap/index.js";
import { Session } from "./interactive/session.js";
import { createProgram } from "./create-program.js";

export function shouldStartSession(args: readonly string[]): boolean {
  return args.length === 0;
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const config = createConfig(process.env as Record<string, string | undefined>);
  // Wire the commander --no-interactive flag into bootstrap before handlers run.
  const interactive = !args.includes("--no-interactive");
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
  let forced = false;
  const onSignal = (): void => {
    if (forced) {
      process.exit(130);
    }
    forced = true;
    controller.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const handlers = await bootstrap(config, {
    interactive,
    signal: controller.signal,
    recover: !isBreakLock,
  });
  try {
    if (shouldStartSession(args)) {
      let app: Instance | undefined;
      const cancelSession = (): void => {
        controller.abort();
        app?.unmount();
      };
      app = render(
        createElement(Session, { handlers, signal: controller.signal, onCancel: cancelSession }),
        { exitOnCtrlC: false },
      );
      controller.signal.addEventListener("abort", () => app?.unmount(), { once: true });
      await app.waitUntilExit();
    } else {
      const program = createProgram({ handlers });
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

// main.ts is only the process entry point, never imported by other modules.
void main();
