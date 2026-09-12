import { describe, expect, it, vi } from "vitest";
import { createKestrelError } from "../application/errors/kestrel-error.js";
import { createProgram } from "./create-program.js";
import type { CommandHandlers } from "./command-handlers.js";
import type { ViewModel } from "./presentation/view-models.js";

type Call = { handler: string; args: unknown };

function authStatusView(detail: "CONNECTED" | "LOGGED_OUT"): ViewModel {
  return {
    kind: "auth-status",
    connected: detail === "CONNECTED",
    login: detail === "CONNECTED" ? "octocat" : null,
    detail,
  };
}

function handlers(overrides: Partial<CommandHandlers> = {}): {
  handlers: CommandHandlers;
  calls: Call[];
} {
  const calls: Call[] = [];
  const record = <Args, Context>(name: string, args: Args, context: Context, view: ViewModel) => {
    calls.push({ handler: name, args: [args, context] });
    return view;
  };
  // Fakes may ignore the second context parameter but must conform to the new
  // (args, context) CommandHandlers signature.
  const base: CommandHandlers = {
    find: async (args, ctx) => record("find", args, ctx, { kind: "verification", text: "find" }),
    authLogin: async (args, ctx) => record("authLogin", args, ctx, authStatusView("CONNECTED")),
    authStatus: async (args, ctx) => record("authStatus", args, ctx, authStatusView("CONNECTED")),
    authLogout: async (args, ctx) => record("authLogout", args, ctx, authStatusView("LOGGED_OUT")),
    missionAccept: async (args, ctx) =>
      record("missionAccept", args, ctx, { kind: "verification", text: "accept" }),
    missionPrepare: async (args, ctx) =>
      record("missionPrepare", args, ctx, { kind: "verification", text: "prepare" }),
    missionResume: async (args, ctx) =>
      record("missionResume", args, ctx, { kind: "verification", text: "resume" }),
    missionCurrent: async (args, ctx) =>
      record("missionCurrent", args, ctx, { kind: "verification", text: "current" }),
    missionComplete: async (args, ctx) =>
      record("missionComplete", args, ctx, { kind: "verification", text: "complete" }),
    missionBreakLock: async (args, ctx) =>
      record("missionBreakLock", args, ctx, { kind: "verification", text: "break-lock" }),
    missionAbandon: async (args, ctx) =>
      record("missionAbandon", args, ctx, { kind: "verification", text: "abandon" }),
    agentBrief: async (args, ctx) =>
      record("agentBrief", args, ctx, { kind: "verification", text: "brief" }),
    verifySubmission: async (args, ctx) =>
      record("verifySubmission", args, ctx, { kind: "verification", text: "submission" }),
    verifyLink: async (args, ctx) =>
      record("verifyLink", args, ctx, { kind: "verification", text: "link" }),
    verifyMerge: async (args, ctx) =>
      record("verifyMerge", args, ctx, { kind: "verification", text: "merge" }),
    journey: async (args, ctx) =>
      record("journey", args, ctx, { kind: "verification", text: "journey" }),
    progress: async (args, ctx) =>
      record("progress", args, ctx, { kind: "verification", text: "progress" }),
    preferencesGet: async (args, ctx) =>
      record("preferencesGet", args, ctx, { kind: "verification", text: "prefs-get" }),
    preferencesSet: async (args, ctx) =>
      record("preferencesSet", args, ctx, { kind: "verification", text: "prefs-set" }),
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
    expect(calls).toEqual([
      { handler: "find", args: [{ mood: "QUICK_WIN", type: "BUG_FIX" }, {}] },
    ]);
  });

  it("routes mission accept with a required recommendation id", async () => {
    const { handlers: h, calls } = handlers();
    await parse(h, ["mission", "accept", "--id", "challenge-42"]);
    expect(calls).toEqual([
      { handler: "missionAccept", args: [{ recommendationId: "challenge-42" }, {}] },
    ]);
  });

  it("rejects mission accept without a recommendation id before running the handler", async () => {
    const { handlers: h, calls } = handlers();
    const c = capture();
    const program = createProgram({ handlers: h, stdout: c.stdout, stderr: c.stderr });
    program.exitOverride();
    await expect(
      program.parseAsync(["node", "kestrel", "mission", "accept"]),
    ).rejects.toMatchObject({ code: "commander.missingMandatoryOptionValue" });
    // The handler must never run for a bare accept.
    expect(calls).toEqual([]);
    expect(c.getErr()).toContain("--id");
    expect(c.getErr()).toContain("recommendation");
  });

  it("routes mission accept with the recommendation identifier", async () => {
    const { handlers: h, calls } = handlers();
    await parse(h, ["mission", "accept", "--id", "challenge-42"]);
    expect(calls).toEqual([
      { handler: "missionAccept", args: [{ recommendationId: "challenge-42" }, {}] },
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
    expect(calls[0]?.args).toEqual([{ missionId: "m1" }, {}]);
  });

  it("routes mission break-lock with --id", async () => {
    const { handlers: h, calls } = handlers();
    await parse(h, ["mission", "break-lock", "--id", "m1"]);
    expect(calls).toEqual([{ handler: "missionBreakLock", args: [{ missionId: "m1" }, {}] }]);
  });

  it("rejects mission break-lock without --id before the handler runs", async () => {
    const { handlers: h, calls } = handlers();
    const c = capture();
    const program = createProgram({ handlers: h, stdout: c.stdout, stderr: c.stderr });
    program.exitOverride();
    await expect(
      program.parseAsync(["node", "kestrel", "mission", "break-lock"]),
    ).rejects.toMatchObject({ code: "commander.missingMandatoryOptionValue" });
    expect(calls).toEqual([]);
    expect(c.getErr()).toContain("--id");
  });

  it("routes mission abandon with --id and --reason", async () => {
    const { handlers: h, calls } = handlers();
    await parse(h, ["mission", "abandon", "--id", "m1", "--reason", "too hard"]);
    expect(calls).toEqual([
      { handler: "missionAbandon", args: [{ missionId: "m1", reason: "too hard" }, {}] },
    ]);
  });

  it("routes agent brief with --hypothesis", async () => {
    const { handlers: h, calls } = handlers();
    await parse(h, ["agent", "brief", "--hypothesis", "null check"]);
    expect(calls).toEqual([{ handler: "agentBrief", args: [{ hypothesis: "null check" }, {}] }]);
  });

  it("routes verify submission, link, and merge with --pr", async () => {
    const { handlers: h, calls } = handlers();
    await parse(h, ["verify", "submission", "--pr", "42"]);
    await parse(h, ["verify", "link", "--pr", "42"]);
    await parse(h, ["verify", "merge", "--pr", "42"]);
    expect(calls.map((c) => c.handler)).toEqual(["verifySubmission", "verifyLink", "verifyMerge"]);
    expect(calls[0]?.args).toEqual([{ prNumber: 42 }, {}]);
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
    expect(calls[3]?.args).toEqual([{ language: "ts", mode: "EXPERT" }, {}]);
  });

  it("routes the legacy top-level current command", async () => {
    const { handlers: h, calls } = handlers();
    await parse(h, ["current"]);
    expect(calls).toEqual([{ handler: "missionCurrent", args: [{}, {}] }]);
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

describe("createProgram auth commands", () => {
  it("routes auth status", async () => {
    const { handlers: h, calls } = handlers();
    await parse(h, ["auth", "status"]);
    expect(calls).toEqual([{ handler: "authStatus", args: [{}, {}] }]);
  });

  it("prints the connected login on stdout for auth status", async () => {
    const { handlers: h } = handlers();
    const { out } = await parse(h, ["auth", "status"]);
    expect(out).toContain("octocat");
  });

  it("emits auth status as a single json document on stdout", async () => {
    const { handlers: h } = handlers();
    const { out, err } = await parse(h, ["--json", "auth", "status"]);
    const parsed = JSON.parse(out) as { ok: boolean; data: { kind: string; login: string } };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.kind).toBe("auth-status");
    expect(err).toBe("");
  });

  it("routes auth login", async () => {
    const { handlers: h, calls } = handlers();
    await parse(h, ["auth", "login"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.handler).toBe("authLogin");
  });

  it("routes auth logout with the confirmation token", async () => {
    const { handlers: h, calls } = handlers();
    await parse(h, ["auth", "logout", "--confirm", "github.com"]);
    expect(calls).toEqual([{ handler: "authLogout", args: [{ confirmation: "github.com" }, {}] }]);
  });

  it("routes auth logout without a confirmation so the use case can refuse", async () => {
    const { handlers: h, calls } = handlers();
    await parse(h, ["auth", "logout"]);
    expect(calls).toEqual([{ handler: "authLogout", args: [{ confirmation: undefined }, {}] }]);
  });

  it("accepts --no-browser on the root program", () => {
    const program = createProgram({
      handlers: handlers().handlers,
      stdout: () => undefined,
      stderr: () => undefined,
    });
    expect(program.helpInformation()).toContain("--no-browser");
  });

  it("documents auth in the root help", () => {
    const program = createProgram({
      handlers: handlers().handlers,
      stdout: () => undefined,
      stderr: () => undefined,
    });
    expect(program.helpInformation()).toContain("auth");
  });

  it("writes device authorization guidance to stderr, keeping json stdout parseable", async () => {
    const { handlers: base } = handlers();
    const h: CommandHandlers = {
      ...base,
      authLogin: async (_args, context) => {
        context.onNotice?.({
          kind: "device-authorization",
          verificationUri: "https://github.com/login/device",
          userCode: "ABCD-1234",
        });
        return {
          kind: "auth-status",
          connected: true,
          login: "octocat",
          detail: "CONNECTED",
        };
      },
    };
    const { out, err } = await parse(h, ["--json", "auth", "login"]);
    expect(err).toContain("https://github.com/login/device");
    expect(err).toContain("ABCD-1234");
    // stdout must remain exactly one parseable JSON document.
    const parsed = JSON.parse(out) as { ok: boolean; data: { kind: string } };
    expect(parsed.data.kind).toBe("auth-status");
  });

  it("writes device authorization guidance to stderr in plain mode too", async () => {
    const { handlers: base } = handlers();
    const h: CommandHandlers = {
      ...base,
      authLogin: async (_args, context) => {
        context.onNotice?.({
          kind: "device-authorization",
          verificationUri: "https://github.com/login/device",
          userCode: "ABCD-1234",
        });
        return {
          kind: "auth-status",
          connected: true,
          login: "octocat",
          detail: "CONNECTED",
        };
      },
    };
    const { out, err } = await parse(h, ["auth", "login"]);
    expect(err).toContain("ABCD-1234");
    expect(out).toContain("octocat");
    expect(out).not.toContain("ABCD-1234");
  });

  it("maps a refused logout to exit code 2", async () => {
    const { handlers: base } = handlers();
    const h: CommandHandlers = {
      ...base,
      authLogout: async () => {
        throw createKestrelError({
          code: "DM_ILLEGAL_TRANSITION",
          category: "INVALID_INPUT",
          userMessage: "Logging out clears the shared github.com credential",
          suggestedActions: ["Re-run with --confirm github.com to clear it"],
          retryability: "NO_RETRY",
          recoveryStrategy: "USER_ACTION",
          severity: "WARNING",
        });
      },
    };
    const previous = process.exitCode;
    try {
      const { err } = await parse(h, ["auth", "logout"]);
      expect(err).toContain("github.com");
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = previous;
    }
  });
});

describe("createProgram auth login guidance", () => {
  function loginWithLaunch(base: CommandHandlers, launched: boolean): CommandHandlers {
    return {
      ...base,
      authLogin: async (_args, context) => {
        context.onNotice?.({
          kind: "device-authorization",
          verificationUri: "https://github.com/login/device",
          userCode: "WDJB-MJHT",
        });
        if (launched) {
          context.onNotice?.({
            kind: "verification",
            text: "Opened your browser to complete authentication.",
          });
        }
        return { kind: "auth-status", connected: true, login: "octocat", detail: "CONNECTED" };
      },
    };
  }

  it("prints the verification uri exactly once when a browser opened", async () => {
    const { handlers: base } = handlers();
    const { err } = await parse(loginWithLaunch(base, true), ["auth", "login"]);
    expect(err.split("https://github.com/login/device").length - 1).toBe(1);
    expect(err).toContain("WDJB-MJHT");
    expect(err).toContain("Opened your browser");
  });

  it("prints the verification uri exactly once when no browser opened", async () => {
    const { handlers: base } = handlers();
    const { err } = await parse(loginWithLaunch(base, false), ["auth", "login"]);
    expect(err.split("https://github.com/login/device").length - 1).toBe(1);
    expect(err).not.toContain("Opened your browser");
  });

  it("prints the user code exactly once when a browser opened", async () => {
    const { handlers: base } = handlers();
    const { err } = await parse(loginWithLaunch(base, true), ["auth", "login"]);
    expect(err.split("WDJB-MJHT").length - 1).toBe(1);
  });
});

describe("createProgram command context forwarding", () => {
  it("forwards the program signal into the auth status handler context", async () => {
    const signal = new AbortController().signal;
    const authStatus = vi.fn().mockResolvedValue(authStatusView("CONNECTED"));
    const c = capture();
    const program = createProgram({
      handlers: handlers({ authStatus }).handlers,
      stdout: c.stdout,
      stderr: c.stderr,
      signal,
    });
    await program.parseAsync(["node", "kestrel", "auth", "status"]);
    expect(authStatus).toHaveBeenCalledWith({}, { signal });
  });

  it("forwards the program signal into the find handler context", async () => {
    const signal = new AbortController().signal;
    const find = vi.fn().mockResolvedValue({ kind: "verification" as const, text: "find" });
    const c = capture();
    const program = createProgram({
      handlers: handlers({ find }).handlers,
      stdout: c.stdout,
      stderr: c.stderr,
      signal,
    });
    await program.parseAsync(["node", "kestrel", "find", "--mood", "QUICK_WIN"]);
    expect(find).toHaveBeenCalledWith({ mood: "QUICK_WIN" }, { signal });
  });

  it("forwards an empty context when no signal is supplied to the program", async () => {
    const authStatus = vi.fn().mockResolvedValue(authStatusView("CONNECTED"));
    const c = capture();
    const program = createProgram({
      handlers: handlers({ authStatus }).handlers,
      stdout: c.stdout,
      stderr: c.stderr,
    });
    await program.parseAsync(["node", "kestrel", "auth", "status"]);
    expect(authStatus).toHaveBeenCalledWith({}, {});
  });

  it("forwards auth login's onNotice through the context", async () => {
    const authLogin = vi.fn().mockImplementation(async (_args, context) => {
      context.onNotice?.({
        kind: "device-authorization",
        verificationUri: "https://github.com/login/device",
        userCode: "ABCD-1234",
      });
      return authStatusView("CONNECTED");
    });
    const c = capture();
    const program = createProgram({
      handlers: handlers({ authLogin }).handlers,
      stdout: c.stdout,
      stderr: c.stderr,
    });
    await program.parseAsync(["node", "kestrel", "auth", "login"]);
    expect(authLogin).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ onNotice: expect.any(Function) }),
    );
    expect(c.getErr()).toContain("ABCD-1234");
  });
});
