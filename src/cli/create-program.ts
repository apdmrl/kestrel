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
  // Route Commander's own help and validation errors through the same injected
  // channels so the CLI output contract is testable and single-sourced.
  program.configureOutput({ writeOut: out, writeErr: err });
  // Turn process.exit() into a thrown CommanderError so callers (tests and the
  // composition root) control exit codes instead of the process. Must be set
  // before subcommands are created; they inherit this callback.
  program.exitOverride();

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
    .action((opts: { mood?: string; type?: string }) =>
      run(() =>
        options.handlers.find({
          mood: opts.mood ?? "QUICK_WIN",
          ...(opts.type !== undefined ? { type: opts.type } : {}),
        }),
      )(),
    );

  program
    .command("current")
    .description("show the current mission")
    .action(() => run(() => options.handlers.missionCurrent({}))());

  const mission = program.command("mission").description("accept, prepare, and manage missions");
  mission
    .command("accept")
    .description("accept the exact recommendation shown by find, bound by its immutable --id")
    .requiredOption("--id <recommendationId>", "accept the recommendation with this identifier")
    .action((opts: { id: string }) =>
      run(() => options.handlers.missionAccept({ recommendationId: opts.id }))(),
    );
  const withMissionId = (command: Command): Command =>
    command.option("--id <missionId>", "target mission id");
  withMissionId(
    mission
      .command("prepare")
      .description("prepare the mission workspace and guidance (resumable)"),
  ).action((opts: { id?: string }) =>
    run(() =>
      options.handlers.missionPrepare({ ...(opts.id !== undefined ? { missionId: opts.id } : {}) }),
    )(),
  );
  withMissionId(
    mission.command("resume").description("resume an interrupted mission preparation"),
  ).action((opts: { id?: string }) =>
    run(() =>
      options.handlers.missionResume({ ...(opts.id !== undefined ? { missionId: opts.id } : {}) }),
    )(),
  );
  withMissionId(mission.command("current").description("show the current mission")).action(
    (opts: { id?: string }) =>
      run(() =>
        options.handlers.missionCurrent({
          ...(opts.id !== undefined ? { missionId: opts.id } : {}),
        }),
      )(),
  );
  withMissionId(
    mission.command("complete").description("complete the mission with local evidence"),
  ).action((opts: { id?: string }) =>
    run(() =>
      options.handlers.missionComplete({
        ...(opts.id !== undefined ? { missionId: opts.id } : {}),
      }),
    )(),
  );
  withMissionId(mission.command("abandon").description("abandon the mission"))
    .option("--reason <reason>", "abandon reason")
    .action((opts: { id?: string; reason?: string }) =>
      run(() =>
        options.handlers.missionAbandon({
          ...(opts.id !== undefined ? { missionId: opts.id } : {}),
          reason: opts.reason ?? "",
        }),
      )(),
    );

  const agent = program.command("agent").description("generate agent guidance");
  withMissionId(agent.command("brief").description("record an immutable agent brief handoff"))
    .option("--hypothesis <text>", "developer hypothesis")
    .action((opts: { id?: string; hypothesis?: string }) =>
      run(() =>
        options.handlers.agentBrief({
          ...(opts.id !== undefined ? { missionId: opts.id } : {}),
          ...(opts.hypothesis !== undefined ? { hypothesis: opts.hypothesis } : {}),
        }),
      )(),
    );

  const verify = program.command("verify").description("verify GitHub submission evidence");
  const prOption = (command: Command): Command =>
    withMissionId(command).option("--pr <number>", "pull request number");
  prOption(verify.command("submission").description("verify a submitted pull request")).action(
    (opts: { id?: string; pr: string }) =>
      run(() =>
        options.handlers.verifySubmission({
          ...(opts.id !== undefined ? { missionId: opts.id } : {}),
          prNumber: Number(opts.pr),
        }),
      )(),
  );
  prOption(verify.command("link").description("verify an issue link for a pull request")).action(
    (opts: { id?: string; pr: string }) =>
      run(() =>
        options.handlers.verifyLink({
          ...(opts.id !== undefined ? { missionId: opts.id } : {}),
          prNumber: Number(opts.pr),
        }),
      )(),
  );
  prOption(verify.command("merge").description("verify a merged pull request")).action(
    (opts: { id?: string; pr: string }) =>
      run(() =>
        options.handlers.verifyMerge({
          ...(opts.id !== undefined ? { missionId: opts.id } : {}),
          prNumber: Number(opts.pr),
        }),
      )(),
  );

  program
    .command("journey")
    .description("show the engineering journey")
    .action(() => run(() => options.handlers.journey())());

  program
    .command("progress")
    .description("show journey progress counts")
    .action(() => run(() => options.handlers.progress())());

  const preferences = program.command("preferences").description("manage preferences");
  preferences
    .command("get")
    .description("show preferences")
    .action(() => run(() => options.handlers.preferencesGet())());
  preferences
    .command("set")
    .description("update preferences")
    .option("--language <language>", "preferred language")
    .option("--mode <mode>", "default mode")
    .action((opts: { language?: string; mode?: string }) =>
      run(() =>
        options.handlers.preferencesSet({
          ...(opts.language !== undefined ? { language: opts.language } : {}),
          ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
        }),
      )(),
    );

  return program;
}
