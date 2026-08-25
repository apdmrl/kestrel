import { describe, expect, it, vi } from "vitest";
import type { CommandHandlers } from "../command-handlers.js";
import type { ViewModel } from "../presentation/view-models.js";
import { createSessionController } from "./session-controller.js";

describe("session controller", () => {
  const view: ViewModel = { kind: "verification", text: "ok" };

  function handlers(): CommandHandlers {
    return {
      find: vi.fn().mockResolvedValue(view),
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

  it("maps representative commands to exact handler arguments", async () => {
    const commandHandlers = handlers();
    const controller = createSessionController(commandHandlers);

    await controller({ kind: "find", mood: "DEEP_DEBUGGING", type: "BUG" });
    await controller({ kind: "mission-current", missionId: "m-1" });
    await controller({ kind: "verify-submission", missionId: "m-1", prNumber: 42 });
    await controller({ kind: "preferences-set", language: "TypeScript", mode: "guided" });

    expect(commandHandlers.find).toHaveBeenCalledWith({ mood: "DEEP_DEBUGGING", type: "BUG" });
    expect(commandHandlers.missionCurrent).toHaveBeenCalledWith({ missionId: "m-1" });
    expect(commandHandlers.verifySubmission).toHaveBeenCalledWith({ missionId: "m-1", prNumber: 42 });
    expect(commandHandlers.preferencesSet).toHaveBeenCalledWith({ language: "TypeScript", mode: "guided" });
  });

  it("handles session-local commands without calling handlers", async () => {
    const commandHandlers = handlers();
    const controller = createSessionController(commandHandlers);

    expect(await controller({ kind: "help" })).toMatchObject({ kind: "output" });
    expect(await controller({ kind: "clear" })).toEqual({ kind: "clear" });
    expect(await controller({ kind: "exit" })).toEqual({ kind: "exit" });
    expect(commandHandlers.progress).not.toHaveBeenCalled();
  });

  it("renders successful view models and converts thrown errors", async () => {
    const commandHandlers = handlers();
    vi.mocked(commandHandlers.progress).mockRejectedValueOnce(new Error("boom"));
    const controller = createSessionController(commandHandlers);

    expect(await controller({ kind: "progress" })).toEqual({ kind: "error", text: expect.stringContaining("boom") });
    expect(await controller({ kind: "journey" })).toEqual({ kind: "output", text: "ok" });
  });
});
