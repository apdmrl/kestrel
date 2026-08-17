import { Command } from "commander";
import { errorToExitCode } from "./error-to-exit-code.js";
import type { CommandHandlers } from "./command-handlers.js";
import { errorViewModel, type ViewModel } from "./presentation/view-models.js";
import { renderPlain } from "./presentation/plain-renderer.js";
import { renderJson } from "./presentation/json-renderer.js";

export interface ProgramOptions {
  readonly handlers: CommandHandlers;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

function runHandler(
  handlers: CommandHandlers,
  json: boolean,
  out: (text: string) => void,
  err: (text: string) => void,
  handler: () => Promise<ViewModel>,
): () => Promise<void> {
  return async () => {
    try {
      const view = await handler();
      out(json ? renderJson(view) : renderPlain(view) + "\n");
    } catch (error) {
      const view = errorViewModel(error);
      err(json ? renderJson(view) : renderPlain(view) + "\n");
      process.exitCode = errorToExitCode(error);
    }
  };
}

/** Build the Commander program with thin command handlers and no domain decisions. */
export function createProgram(options: ProgramOptions): Command {
  const program = new Command();
  const out = options.stdout ?? ((text) => process.stdout.write(text));
  const err = options.stderr ?? ((text) => process.stderr.write(text));

  program
    .name("kestrel")
    .description("Local-first terminal companion for real open-source challenges")
    .version("0.1.0")
    .option("--plain", "emit plain output")
    .option("--json", "emit machine-readable JSON")
    .option("--no-interactive", "disable interactive prompts");

  const isJson = (): boolean => (program.opts() as { json?: boolean }).json === true;
  const run = (handler: () => Promise<ViewModel>) =>
    runHandler(options.handlers, isJson(), out, err, handler);

  program
    .command("find")
    .description("discover one recommended challenge")
    .option("--mood <mood>", "mood to use")
    .option("--type <type>", "mission type override")
    .action((opts: { mood?: string; type?: string }) => {
      void run(() =>
        options.handlers.find({
          mood: opts.mood ?? "QUICK_WIN",
          ...(opts.type !== undefined ? { type: opts.type } : {}),
        }),
      )();
    });

  program
    .command("current")
    .description("show the current mission")
    .action(() => {
      void run(() => options.handlers.missionCurrent())();
    });

  program
    .command("journey")
    .description("show the engineering journey")
    .action(() => {
      void run(() => options.handlers.journey())();
    });

  program
    .command("progress")
    .description("show journey progress counts")
    .action(() => {
      void run(() => options.handlers.progress())();
    });

  const preferences = program.command("preferences").description("manage preferences");
  preferences
    .command("get")
    .description("show preferences")
    .action(() => {
      void run(() => options.handlers.preferencesGet())();
    });
  preferences
    .command("set")
    .description("update preferences")
    .option("--language <language>", "preferred language")
    .option("--mode <mode>", "default mode")
    .action((opts: { language?: string; mode?: string }) => {
      void run(() =>
        options.handlers.preferencesSet({
          ...(opts.language !== undefined ? { language: opts.language } : {}),
          ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
        }),
      )();
    });

  return program;
}
