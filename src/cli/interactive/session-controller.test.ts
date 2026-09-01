import { describe, expect, it, vi } from "vitest";
import type { CommandContext, CommandHandlers } from "../command-handlers.js";
import type { ViewModel } from "../presentation/view-models.js";
import { createSessionController } from "./session-controller.js";

describe("session controller", () => {
  const view: ViewModel = { kind: "verification", text: "ok" };
  const emptyContext: CommandContext = {};

  function handlers(): CommandHandlers {
    return {
      find: vi.fn().mockResolvedValue(view),
      authLogin: vi.fn().mockResolvedValue(view),
      authStatus: vi.fn().mockResolvedValue(view),
      authLogout: vi.fn().mockResolvedValue(view),
      missionAccept: vi.fn().mockResolvedValue(view),
      missionPrepare: vi.fn().mockResolvedValue(view),
      missionResume: vi.fn().mockResolvedValue(view),
      missionCurrent: vi.fn().mockResolvedValue(view),
      missionComplete: vi.fn().mockResolvedValue(view),
      missionBreakLock: vi.fn().mockResolvedValue(view),
      missionAbandon: vi.fn().mockResolvedValue(view),
      agentBrief: vi.fn().mockResolvedValue(view),
      verifySubmission: vi.fn().mockResolvedValue(view),
      verifyLink: vi.fn().mockResolvedValue(view),
      verifyMerge: vi.fn().mockResolvedValue(view),
      journey: vi.fn().mockResolvedValue(view),
      progress: vi.fn().mockResolvedValue(view),
      preferencesGet: vi.fn().mockResolvedValue(view),
      preferencesSet: vi.fn().mockResolvedValue(view),
    };
  }

  it("maps representative commands to exact handler arguments and forwards context", async () => {
    const commandHandlers = handlers();
    const controller = createSessionController(commandHandlers);
    const context: CommandContext = {};

    await controller({ kind: "find", mood: "DEEP_DEBUGGING", type: "BUG" }, context);
    await controller({ kind: "mission-current", missionId: "m-1" }, context);
    await controller({ kind: "verify-submission", missionId: "m-1", prNumber: 42 }, context);
    await controller({ kind: "preferences-set", language: "TypeScript", mode: "guided" }, context);

    await controller({ kind: "mission-accept", recommendationId: "r-1" }, context);
    await controller({ kind: "mission-prepare", missionId: "m-1" }, context);
    await controller({ kind: "mission-resume", missionId: "m-1" }, context);
    await controller({ kind: "mission-complete", missionId: "m-1" }, context);
    await controller({ kind: "mission-abandon", missionId: "m-1", reason: "done" }, context);
    await controller({ kind: "mission-break-lock", missionId: "m-1" }, context);
    await controller({ kind: "agent-brief", missionId: "m-1", hypothesis: "h" }, context);
    await controller({ kind: "verify-link", missionId: "m-1", prNumber: 42 }, context);
    await controller({ kind: "verify-merge", missionId: "m-1", prNumber: 42 }, context);
    await controller({ kind: "journey" }, context);
    await controller({ kind: "progress" }, context);
    await controller({ kind: "preferences-get" }, context);

    expect(commandHandlers.find).toHaveBeenCalledWith(
      { mood: "DEEP_DEBUGGING", type: "BUG" },
      context,
    );
    expect(commandHandlers.missionCurrent).toHaveBeenCalledWith({ missionId: "m-1" }, context);
    expect(commandHandlers.verifySubmission).toHaveBeenCalledWith(
      {
        missionId: "m-1",
        prNumber: 42,
      },
      context,
    );
    expect(commandHandlers.preferencesSet).toHaveBeenCalledWith(
      {
        language: "TypeScript",
        mode: "guided",
      },
      context,
    );
    expect(commandHandlers.missionAccept).toHaveBeenCalledWith(
      { recommendationId: "r-1" },
      context,
    );
    expect(commandHandlers.missionPrepare).toHaveBeenCalledWith({ missionId: "m-1" }, context);
    expect(commandHandlers.missionResume).toHaveBeenCalledWith({ missionId: "m-1" }, context);
    expect(commandHandlers.missionComplete).toHaveBeenCalledWith({ missionId: "m-1" }, context);
    expect(commandHandlers.missionAbandon).toHaveBeenCalledWith(
      {
        missionId: "m-1",
        reason: "done",
      },
      context,
    );
    expect(commandHandlers.missionBreakLock).toHaveBeenCalledWith({ missionId: "m-1" }, context);
    expect(commandHandlers.agentBrief).toHaveBeenCalledWith(
      { missionId: "m-1", hypothesis: "h" },
      context,
    );
    expect(commandHandlers.verifyLink).toHaveBeenCalledWith(
      { missionId: "m-1", prNumber: 42 },
      context,
    );
    expect(commandHandlers.verifyMerge).toHaveBeenCalledWith(
      { missionId: "m-1", prNumber: 42 },
      context,
    );
    expect(commandHandlers.journey).toHaveBeenCalledWith({}, context);
    expect(commandHandlers.progress).toHaveBeenCalledWith({}, context);
    expect(commandHandlers.preferencesGet).toHaveBeenCalledWith({}, context);
  });

  it("forwards the supplied command signal through to handlers", async () => {
    const commandHandlers = handlers();
    const controller = createSessionController(commandHandlers);
    const signal = new AbortController().signal;
    const context: CommandContext = { signal };

    await controller({ kind: "journey" }, context);

    expect(commandHandlers.journey).toHaveBeenCalledWith({}, context);
    const callArgs = vi.mocked(commandHandlers.journey).mock.calls[0];
    expect(callArgs?.[1]).toBe(context);
    expect(callArgs?.[1]?.signal).toBe(signal);
  });

  it("handles session-local commands without calling handlers", async () => {
    const commandHandlers = handlers();
    const controller = createSessionController(commandHandlers);

    expect(await controller({ kind: "help" }, emptyContext)).toMatchObject({ kind: "output" });
    expect(await controller({ kind: "clear" }, emptyContext)).toEqual({ kind: "clear" });
    expect(await controller({ kind: "exit" }, emptyContext)).toEqual({ kind: "exit" });
    for (const handler of Object.values(commandHandlers)) {
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it("renders successful view models and converts thrown errors", async () => {
    const commandHandlers = handlers();
    vi.mocked(commandHandlers.progress).mockRejectedValueOnce(new Error("boom"));
    const controller = createSessionController(commandHandlers);

    expect(await controller({ kind: "progress" }, emptyContext)).toEqual({
      kind: "error",
      text: expect.stringContaining("boom"),
    });
    expect(await controller({ kind: "journey" }, emptyContext)).toEqual({
      kind: "output",
      text: "ok",
    });
  });
  it("routes the auth commands to their handlers", async () => {
    const commandHandlers = handlers();
    const controller = createSessionController(commandHandlers);

    await controller({ kind: "auth-login" }, emptyContext);
    await controller({ kind: "auth-status" }, emptyContext);
    await controller({ kind: "auth-logout", confirmation: "github.com" }, emptyContext);

    expect(commandHandlers.authStatus).toHaveBeenCalledWith({}, emptyContext);
    expect(commandHandlers.authLogout).toHaveBeenCalledWith(
      { confirmation: "github.com" },
      emptyContext,
    );
  });

  it("routes /auth logout without a confirmation so the use case refuses", async () => {
    const commandHandlers = handlers();
    const controller = createSessionController(commandHandlers);
    await controller({ kind: "auth-logout" }, emptyContext);
    expect(commandHandlers.authLogout).toHaveBeenCalledWith(
      { confirmation: undefined },
      emptyContext,
    );
  });

  it("delivers device authorization guidance through the notify channel", async () => {
    const commandHandlers = handlers();
    vi.mocked(commandHandlers.authLogin).mockImplementationOnce(async (_args, context) => {
      context.onNotice?.({
        kind: "device-authorization",
        verificationUri: "https://github.com/login/device",
        userCode: "ABCD-1234",
      });
      return view;
    });
    const notices: string[] = [];
    const controller = createSessionController(commandHandlers, (text) => notices.push(text));

    await controller({ kind: "auth-login" }, emptyContext);

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("https://github.com/login/device");
    expect(notices[0]).toContain("ABCD-1234");
  });

  it("does not fail when no notify channel is supplied", async () => {
    const commandHandlers = handlers();
    vi.mocked(commandHandlers.authLogin).mockImplementationOnce(async (_args, context) => {
      context.onNotice?.({
        kind: "device-authorization",
        verificationUri: "https://github.com/login/device",
        userCode: "ABCD-1234",
      });
      return view;
    });
    const controller = createSessionController(commandHandlers);
    expect(await controller({ kind: "auth-login" }, emptyContext)).toEqual({
      kind: "output",
      text: "ok",
    });
  });

  it("lists /auth in the session help", async () => {
    const controller = createSessionController(handlers());
    const result = await controller({ kind: "help" }, emptyContext);
    expect(result).toMatchObject({ kind: "output", text: expect.stringContaining("/auth") });
  });
});