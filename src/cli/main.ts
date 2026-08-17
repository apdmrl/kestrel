#!/usr/bin/env node
import { bootstrap, createConfig } from "../bootstrap/index.js";
import { createProgram } from "./create-program.js";

export async function main(): Promise<void> {
  const config = createConfig(process.env as Record<string, string | undefined>);
  const handlers = await bootstrap(config);
  const program = createProgram({ handlers });
  await program.parseAsync(process.argv);
}

// main.ts is only the process entry point, never imported by other modules.
void main();
