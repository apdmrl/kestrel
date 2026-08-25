import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandHandlers } from "../command-handlers.js";
import type { ViewModel } from "../presentation/view-models.js";
import { Session } from "./session.js";

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

describe("persistent session", () => {
  afterEach(() => cleanup());

  it("renders the Matrix-green shell header and prompt", () => {
    const { lastFrame } = render(<Session handlers={handlers()} signal={new AbortController().signal} />);
    expect(lastFrame()).toContain("KESTREL");
    expect(lastFrame()).toContain("session: ready");
    expect(lastFrame()).toContain("kestrel ›");
    expect(lastFrame()).toContain("Type /help");
  });

  it("renders the cancelled state without starting a handler", () => {
    const controller = new AbortController();
    controller.abort();
    const { lastFrame } = render(<Session handlers={handlers()} signal={controller.signal} />);
    expect(lastFrame()).toContain("session: ready");
    expect(lastFrame()).toContain("/help");
  });
});
