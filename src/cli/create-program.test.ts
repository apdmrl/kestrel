import { describe, expect, it } from "vitest";
import { createKestrelError } from "../application/errors/kestrel-error.js";
import { createProgram } from "./create-program.js";
import type { CommandHandlers } from "./command-handlers.js";

function handlers(overrides: Partial<CommandHandlers> = {}): CommandHandlers {
  return {
    find: async ({ mood }) => ({
      kind: "recommendation",
      challengeId: "c1",
      title: "Fix crash",
      mood,
      confidence: 0.8,
      reasons: ["matches"],
    }),
    missionCurrent: async () => ({
      kind: "mission",
      id: "m1",
      status: "IN_PROGRESS",
      title: "Fix crash",
    }),
    journey: async () => ({
      kind: "progress",
      counts: { accepted: 1, completed: 0, submitted: 0, linked: 0, merged: 0, abandoned: 0 },
    }),
    progress: async () => ({
      kind: "progress",
      counts: { accepted: 1, completed: 0, submitted: 0, linked: 0, merged: 0, abandoned: 0 },
    }),
    preferencesGet: async () => ({
      kind: "progress",
      counts: { accepted: 0, completed: 0, submitted: 0, linked: 0, merged: 0, abandoned: 0 },
    }),
    preferencesSet: async () => ({
      kind: "progress",
      counts: { accepted: 0, completed: 0, submitted: 0, linked: 0, merged: 0, abandoned: 0 },
    }),
    ...overrides,
  };
}

function capture() {
  let out = "";
  let err = "";
  return {
    out,
    err,
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

describe("createProgram", () => {
  it("routes the find command with mood and type", async () => {
    const seen: Array<{ mood: string; type?: string }> = [];
    const h = handlers({
      find: async (args) => {
        seen.push(args);
        return { kind: "verification", text: "found" };
      },
    });
    const c = capture();
    const program = createProgram({ handlers: h, stdout: c.stdout, stderr: c.stderr });
    await program.parseAsync([
      "node",
      "kestrel",
      "find",
      "--mood",
      "QUICK_WIN",
      "--type",
      "BUG_FIX",
    ]);
    expect(seen).toEqual([{ mood: "QUICK_WIN", type: "BUG_FIX" }]);
    expect(c.getOut()).toContain("found");
  });

  it("emits JSON output with --json", async () => {
    const c = capture();
    const program = createProgram({ handlers: handlers(), stdout: c.stdout, stderr: c.stderr });
    await program.parseAsync(["node", "kestrel", "--json", "progress"]);
    const parsed = JSON.parse(c.getOut()) as { ok: boolean };
    expect(parsed.ok).toBe(true);
  });

  it("routes the journey command", async () => {
    const c = capture();
    const program = createProgram({ handlers: handlers(), stdout: c.stdout, stderr: c.stderr });
    await program.parseAsync(["node", "kestrel", "journey"]);
    expect(c.getOut()).toContain("Accepted: 1");
  });

  it("maps a classified error to stderr and an exit code", async () => {
    const h = handlers({
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
