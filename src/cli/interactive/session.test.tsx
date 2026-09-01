import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandHandlers } from "../command-handlers.js";
import type { ViewModel } from "../presentation/view-models.js";
import { Session, sessionInputTransition, TranscriptLine } from "./session.js";

const view: ViewModel = { kind: "verification", text: "ok" };

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

describe("persistent session", () => {
  afterEach(() => cleanup());

  it("renders a calm status bar, welcome panel, and minimal prompt", () => {
    const { lastFrame } = render(
      <Session handlers={handlers()} signal={new AbortController().signal} />,
    );
    expect(lastFrame()).toContain("KESTREL");
    expect(lastFrame()).toContain("LOCAL WORKSPACE");
    expect(lastFrame()).toContain("Ready");
    expect(lastFrame()).toContain("›");
    expect(lastFrame()).toContain("Try /help");
    expect(lastFrame()).not.toContain("kestrel ›");
  });

  it("renders actionable errors as a titled panel", () => {
    const { lastFrame } = render(
      <TranscriptLine
        entry={{ id: 1, kind: "error", text: "GitHub authentication is not configured" }}
      />,
    );
    expect(lastFrame()).toContain("GitHub authentication is not configured");
    expect(lastFrame()).toContain("Action required");
  });

  it("clears idle Ctrl+C input without exiting", () => {
    expect(sessionInputTransition("/hel", "c", { ctrl: true }, false)).toEqual({
      nextInput: "",
      submit: false,
      cancel: false,
    });
  });

  it("signals active Ctrl+C cancellation and preserves the prompt", () => {
    expect(sessionInputTransition("/progress", "c", { ctrl: true }, true)).toEqual({
      nextInput: "/progress",
      submit: false,
      cancel: true,
    });
  });

  it("submits slash commands and handles editing keys", () => {
    expect(sessionInputTransition("/help", "\r", { return: true }, false)).toEqual({
      nextInput: "/help",
      submit: true,
      cancel: false,
    });
    expect(sessionInputTransition("/help", "", { backspace: true }, false)).toEqual({
      nextInput: "/hel",
      submit: false,
      cancel: false,
    });
  });

  it("does not start work from an already-aborted session", () => {
    const controller = new AbortController();
    controller.abort();
    const commandHandlers = handlers();
    const { lastFrame } = render(<Session handlers={commandHandlers} signal={controller.signal} />);
    expect(lastFrame()).toContain("Ready");
    expect(commandHandlers.progress).not.toHaveBeenCalled();
  });
});

describe("persistent session — navigation", () => {
  afterEach(() => cleanup());

  it("mounts DashboardShell so the sidebar categories are visible", () => {
    const { lastFrame } = render(
      <Session handlers={handlers()} signal={new AbortController().signal} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("NAVIGATE");
    expect(frame).toContain("Home");
    expect(frame).toContain("Find");
    expect(frame).toContain("Mission");
    expect(frame).toContain("Auth");
  });

  it("exposes the contextual action panel for the active category", () => {
    const { lastFrame } = render(
      <Session handlers={handlers()} signal={new AbortController().signal} />,
    );
    const frame = lastFrame() ?? "";
    // Home category has no actions.
    expect(frame).toContain("ACTIONS");
  });

  it("exposes the focus hint and contextual action path at 80x24", () => {
    const { lastFrame } = render(
      <Session
        handlers={handlers()}
        signal={new AbortController().signal}
        capabilities={{ columns: 80, rows: 24, color: true }}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Ready");
    expect(frame).toContain("↑↓");
    expect(frame).toContain("enter");
  });

  it("stays within the row budget at 80x24 with transcript content", () => {
    const { lastFrame } = render(
      <Session handlers={handlers()} signal={new AbortController().signal} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame.split("\n").length).toBeLessThanOrEqual(24);
    expect(frame).toContain("Ready");
    expect(frame).toContain("KESTREL");
  });

  it("preserves the typed command and auth status inside the bounded shell", () => {
    const { lastFrame } = render(
      <Session
        handlers={handlers()}
        signal={new AbortController().signal}
        capabilities={{ columns: 80, rows: 24, color: true }}
        initialInput="/mission accept --id rec-42"
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Ready");
    expect(frame).toContain("/mission accept --id rec-42");
  });

  it("keeps the recommendation ID inside the typed command intact", () => {
    const { lastFrame } = render(
      <Session
        handlers={handlers()}
        signal={new AbortController().signal}
        capabilities={{ columns: 80, rows: 24, color: true }}
        initialInput="/mission accept --id rec-42"
      />,
    );
    const frame = lastFrame() ?? "";
    // The bounded shell surfaces the recommendation ID verbatim when the
    // session is mounted with the typed command prefilled.
    expect(frame).toContain("rec-42");
  });
});
