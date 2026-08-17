import { describe, expect, it } from "vitest";
import { createKestrelError } from "../application/errors/kestrel-error.js";
import { createProgram } from "./create-program.js";
import type { CommandHandlers } from "./command-handlers.js";
import type { ViewModel } from "./presentation/view-models.js";

type Call = { handler: string; args: unknown };

function handlers(overrides: Partial<CommandHandlers> = {}): {
  handlers: CommandHandlers;
  calls: Call[];
} {
  const calls: Call[] = [];
  const record = <A extends unknown[]>(name: string, args: A, view: ViewModel) => {
    calls.push({ handler: name, args });
    return view;
  };
  const base: CommandHandlers = {
    find: async (args) => record("find", [args], { kind: "verification", text: "find" }),
    missionAccept: async (args) =>
      record("missionAccept", [args], { kind: "verification", text: "accept" }),
    missionPrepare: async (args) =>
      record("missionPrepare", [args], { kind: "verification", text: "prepare" }),
    missionResume: async (args) =>
      record("missionResume", [args], { kind: "verification", text: "resume" }),
    missionCurrent: async (args) =>
      record("missionCurrent", [args], { kind: "verification", text: "current" }),
    missionComplete: async (args) =>
      record("missionComplete", [args], { kind: "verification", text: "complete" }),
    missionAbandon: async (args) =>
      record("missionAbandon", [args], { kind: "verification", text: "abandon" }),
    agentBrief: async (args) =>
      record("agentBrief", [args], { kind: "verification", text: "brief" }),
    verifySubmission: async (args) =>
      record("verifySubmission", [args], { kind: "verification", text: "submission" }),
    verifyLink: async (args) =>
      record("verifyLink", [args], { kind: "verification", text: "link" }),
    verifyMerge: async (args) =>
      record("verifyMerge", [args], { kind: "verification", text: "merge" }),
    journey: async () => record("journey", [], { kind: "verification", text: "journey" }),
    progress: async () => record("progress", [], { kind: "verification", text: "progress" }),
    preferencesGet: async () =>
      record("preferencesGet", [], { kind: "verification", text: "prefs-get" }),
    preferencesSet: async (args) =>
      record("preferencesSet", [args], { kind: "verification", text: "prefs-set" }),
    ...overrides,
  };
  return { handlers: base, calls };
}

function capture() {
  let out = "";
  let err = "";
  return {
    stdout: (text: string) => {
      out += text;
    },
    stderr: (text: string) => {
      err += text;
    },
    getOut: () => out,
    getErr: () => err,
  };
}

async function parse(
  handlers: CommandHandlers,
  argv: string[],
): Promise<{ out: string; err: string }> {
  const c = capture();
  const program = createProgram({ handlers, stdout: c.stdout, stderr: c.stderr });
  await program.parseAsync(["node", "kestrel", ...argv]);
  return { out: c.getOut(), err: c.getErr() };
}

describe("createProgram command routing", () => {
  it("routes find with mood and type", async () => {
    const { handlers: h, calls } = handlers();
    await parse(h, ["find", "--mood", "QUICK_WIN", "--type", "BUG_FIX"]);
    expect(calls).toEqual([{ handler: "find", args: [{ mood: "QUICK_WIN", type: "BUG_FIX" }] }]);
  });

  it("routes mission accept with a required recommendation id", async () => {
    const { handlers: h, calls } = handlers();
    await parse(h, ["mission", "accept", "--id", "challenge-42"]);
    expect(calls).toEqual([
      { handler: "missionAccept", args: [{ recommendationId: "challenge-42" }] },
    ]);
  });

  it("rejects mission accept without a recommendation id before running the handler", async () => {
    const { handlers: h, calls } = handlers();
    const c = capture();
    const program = createProgram({ handlers: h, stdout: c.stdout, stderr: c.stderr });
    program.exitOverride();
    await expect(program.parseAsync(["node", "kestrel", "mission", "accept"])).rejects.toMatchObject(
      { code: "commander.missingMandatoryOptionValue" },
    );
    // The handler must never run for a bare accept.
    expect(calls).toEqual([]);
    expect(c.getErr()).toContain("--id");
    expect(c.getErr()).toContain("recommendation");
  });

  it("routes mission accept with the recommendation identifier", async () => {
    const { handlers: h, calls } = handlers();
    await parse(h, ["mission", "accept", "--id", "challenge-42"]);
    expect(calls).toEqual([
      { handler: "missionAccept", args: [{ recommendationId: "challenge-42" }] },
    ]);
  });

  it("documents the mission accept recommendation identifier", () => {
    const program = createProgram({
      handlers: handlers().handlers,
      stdout: () => undefined,
      stderr: () => undefined,
    });
    const mission = program.commands.find((c) => c.name() === "mission");
    const accept = mission?.commands.find((c) => c.name() === "accept");
    expect(accept).toBeDefined();
    const help = accept?.helpInformation() ?? "";
    expect(help).toContain("--id");
    expect(help).toContain("recommendation");
  });

  it("routes mission prepare, resume, current, and complete with --id", async () => {
    const { handlers: h, calls } = handlers();
    await parse(h, ["mission", "prepare", "--id", "m1"]);
    await parse(h, ["mission", "resume", "--id", "m1"]);
    await parse(h, ["mission", "current", "--id", "m1"]);
    await parse(h, ["mission", "complete", "--id", "m1"]);
    expect(calls.map((c) => c.handler)).toEqual([
      "missionPrepare",
      "missionResume",
      "missionCurrent",
      "missionComplete",
    ]);
    expect(calls[0]?.args).toEqual([{ missionId: "m1" }]);
  });

  it("routes mission abandon with --id and --reason", async () => {
    const { handlers: h, calls } = handlers();
    await parse(h, ["mission", "abandon", "--id", "m1", "--reason", "too hard"]);
    expect(calls).toEqual([
      { handler: "missionAbandon", args: [{ missionId: "m1", reason: "too hard" }] },
    ]);
  });

  it("routes agent brief with --hypothesis", async () => {
    const { handlers: h, calls } = handlers();
    await parse(h, ["agent", "brief", "--hypothesis", "null check"]);
    expect(calls).toEqual([{ handler: "agentBrief", args: [{ hypothesis: "null check" }] }]);
  });

  it("routes verify submission, link, and merge with --pr", async () => {
    const { handlers: h, calls } = handlers();
    await parse(h, ["verify", "submission", "--pr", "42"]);
    await parse(h, ["verify", "link", "--pr", "42"]);
    await parse(h, ["verify", "merge", "--pr", "42"]);
    expect(calls.map((c) => c.handler)).toEqual(["verifySubmission", "verifyLink", "verifyMerge"]);
    expect(calls[0]?.args).toEqual([{ prNumber: 42 }]);
  });

  it("routes journey, progress, and preferences get/set", async () => {
    const { handlers: h, calls } = handlers();
    await parse(h, ["journey"]);
    await parse(h, ["progress"]);
    await parse(h, ["preferences", "get"]);
    await parse(h, ["preferences", "set", "--language", "ts", "--mode", "EXPERT"]);
    expect(calls.map((c) => c.handler)).toEqual([
      "journey",
      "progress",
      "preferencesGet",
      "preferencesSet",
    ]);
    expect(calls[3]?.args).toEqual([{ language: "ts", mode: "EXPERT" }]);
  });

  it("routes the legacy top-level current command", async () => {
    const { handlers: h, calls } = handlers();
    await parse(h, ["current"]);
    expect(calls).toEqual([{ handler: "missionCurrent", args: [{}] }]);
  });

  it("emits JSON output with --json", async () => {
    const c = capture();
    const program = createProgram({
      handlers: handlers().handlers,
      stdout: c.stdout,
      stderr: c.stderr,
    });
    await program.parseAsync(["node", "kestrel", "--json", "progress"]);
    const parsed = JSON.parse(c.getOut()) as { ok: boolean; data: { kind: string } };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.kind).toBe("verification");
  });

  it("maps a classified error to stderr and a nonzero exit code", async () => {
    const { handlers: h } = handlers({
      find: async () => {
        throw createKestrelError({
          code: "DM_UNSAFE_PATH",
          category: "INVALID_INPUT",
          userMessage: "bad input",
          suggestedActions: ["fix it"],
          retryability: "NO_RETRY",
          recoveryStrategy: "USER_ACTION",
          severity: "ERROR",
        });
      },
    });
    const c = capture();
    const program = createProgram({ handlers: h, stdout: c.stdout, stderr: c.stderr });
    await program.parseAsync(["node", "kestrel", "find"]);
    expect(c.getErr()).toContain("bad input");
    expect(process.exitCode).toBe(2);
    process.exitCode = 0;
  });
});
