#!/usr/bin/env node
import { bootstrap, createConfig } from "../bootstrap/index.js";
import { createProgram } from "./create-program.js";

export async function main(): Promise<void> {
  const config = createConfig(process.env as Record<string, string | undefined>);
  // Wire the commander --no-interactive flag into bootstrap before handlers run.
  const interactive = !process.argv.includes("--no-interactive");
  // The exact `mission break-lock` invocation must run before journal replay so
  // a stale lock that replay would trip over can be cleared first.
  const isBreakLock = ((): boolean => {
    const positional = process.argv.slice(2).filter((a) => !a.startsWith("-"));
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
  const program = createProgram({ handlers });
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    // createProgram enables exitOverride, so Commander never calls
    // process.exit directly: it has already written the message and help to
    // stderr through the configured channel. Propagate its exit code.
    const exitCode = (error as { exitCode?: unknown }).exitCode;
    process.exitCode = typeof exitCode === "number" ? exitCode : 1;
  }
}

// main.ts is only the process entry point, never imported by other modules.
void main();
