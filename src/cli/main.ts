import { bootstrap, createConfig } from "../bootstrap/index.js";
import { createProgram } from "./create-program.js";

export async function main(): Promise<void> {
  const config = createConfig(process.env as Record<string, string | undefined>);
  const handlers = await bootstrap(config);
  const program = createProgram({ handlers });
  await program.parseAsync(process.argv);
}
