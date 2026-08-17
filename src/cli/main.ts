import { createProgram } from "./create-program.js";
import type { CommandHandlers } from "./command-handlers.js";

// The composition root (bootstrap) supplies the concrete handlers.
export async function main(handlers: CommandHandlers): Promise<void> {
  const program = createProgram({ handlers });
  await program.parseAsync(process.argv);
}
