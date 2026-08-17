#!/usr/bin/env node
import { bootstrap, createConfig } from "../bootstrap/index.js";
import { createProgram } from "./create-program.js";

export async function main(): Promise<void> {
  const config = createConfig(process.env as Record<string, string | undefined>);
  // Wire the commander --no-interactive flag into bootstrap before handlers run.
  const interactive = !process.argv.includes("--no-interactive");
  const handlers = await bootstrap(config, { interactive });
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
