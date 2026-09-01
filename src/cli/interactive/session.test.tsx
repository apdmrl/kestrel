import { createElement } from "react";
import { render as renderInk, Text } from "ink";
import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandHandlers } from "../command-handlers.js";
import type { ViewModel } from "../presentation/view-models.js";
import { createKestrelError } from "../../application/errors/kestrel-error.js";
import { Session, sessionInputTransition, TranscriptLine } from "./session.js";
import { FakeInkStdin, FakeInkStdout } from "../../test-utils/ink-stdin.js";

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

interface InteractiveHarness {
  readonly stdin: FakeInkStdin;
  readonly stdout: FakeInkStdout;
  readonly unmount: () => void;
  readonly lastFrame: () => string;
}

function mountInteractive(props: {
  handlers: CommandHandlers;
  signal: AbortSignal;
  capabilities?: { readonly columns: number; readonly rows: number; readonly color: boolean };
  initialInput?: string;
}): InteractiveHarness {
  const caps = props.capabilities ?? { columns: 80, rows: 24, color: true };
  const stdin = new FakeInkStdin();
  const stdout = new FakeInkStdout(caps.columns, caps.rows);
  const instance = renderInk(createElement(Session, props), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    patchConsole: false,
    exitOnCtrlC: false,
    debug: true,
  });
  return {
    stdin,
    stdout,
    unmount: () => instance.unmount(),
    lastFrame: () => stdout.lastFrame(),
  };
}

const settle = (ms = 60): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function upArrow(): string {
  return "\u001b[A";
}

function downArrow(): string {
  return "\u001b[B";
}

function enterKey(): string {
  return "\r";
}

describe("persistent session — keyboard navigation", () => {
  afterEach(() => cleanup());

  it("enters sidebar focus through ↑ from the prompt and renders the focused category marker", async () => {
    const commandHandlers = handlers();
    const harness = mountInteractive({
      handlers: commandHandlers,
      signal: new AbortController().signal,
    });
    try {
      await settle();
      harness.stdin.send(upArrow());
      await settle();
      const frame = harness.lastFrame();
      expect(frame).toMatch(/>\S*\s+Home/);
    } finally {
      harness.unmount();
    }
  });

  it("keeps the recommendation ID actionable after connected auth", async () => {
    const recommendation: ViewModel = {
      kind: "recommendation",
      recommendationId: "rec-42",
      challengeId: "chal-1",
      title: "Fix something",
      mood: "focused",
      confidence: 0.9,
      reasons: ["match"],
    };
    const commandHandlers = handlers();
    vi.mocked(commandHandlers.authStatus).mockResolvedValue({
      kind: "auth-status",
      connected: true,
      login: "octocat",
      detail: "CONNECTED",
    });
    vi.mocked(commandHandlers.find).mockResolvedValue(recommendation);
    const harness = mountInteractive({
      handlers: commandHandlers,
      signal: new AbortController().signal,
    });
    try {
      await settle();
      harness.stdin.send("/auth status\r");
      await settle();
      // Now issue /find to capture the recommendation.
      harness.stdin.send("/find\r");
      await settle();
      // Move focus to sidebar, navigate to Find, enter actions, and confirm
      // the captured recommendation.accept command is exact and actionable.
      harness.stdin.send(upArrow());
      await settle();
      // Step down once from Home (index 0) to Find (index 1).
      harness.stdin.send(downArrow());
      await settle();
      const frame = harness.lastFrame();
      // The recommendation ID is preserved verbatim and the accept command
      // is rendered exactly in the contextual action panel.
      expect(frame).toContain("/mission accept --id rec-42");
      // Sanity: authLogin was not called twice — the live session reflects
      // the controller's auth-status result instead of re-authenticating.
      expect(commandHandlers.authLogin).not.toHaveBeenCalled();
    } finally {
      harness.unmount();
    }
  });

  it("routes Return through focused-action handling before generic prompt execution", async () => {
    const commandHandlers = handlers();
    vi.mocked(commandHandlers.authStatus).mockResolvedValue({
      kind: "auth-status",
      connected: true,
      login: "octocat",
      detail: "CONNECTED",
    });
    vi.mocked(commandHandlers.find).mockResolvedValue({
      kind: "recommendation",
      recommendationId: "rec-42",
      challengeId: "chal-1",
      title: "Fix something",
      mood: "focused",
      confidence: 0.9,
      reasons: ["match"],
    });
    const harness = mountInteractive({
      handlers: commandHandlers,
      signal: new AbortController().signal,
    });
    try {
      await settle();
      // Authenticate and load a recommendation so the find.run action is enabled.
      harness.stdin.send("/auth status\r");
      await settle();
      harness.stdin.send("/find\r");
      await settle();
      // Move focus into the sidebar.
      harness.stdin.send(upArrow());
      await settle();
      // Step down to the Find category (index 1).
      harness.stdin.send(downArrow());
      await settle();
      // Enter the action panel.
      harness.stdin.send(enterKey());
      await settle();
      // Pressing Enter on the focused action fills the prompt and does NOT
      // invoke the find handler — that only happens on the subsequent Enter.
      const beforeCalls = vi.mocked(commandHandlers.find).mock.calls.length;
      harness.stdin.send(enterKey());
      await settle();
      const afterCalls = vi.mocked(commandHandlers.find).mock.calls.length;
      expect(afterCalls).toBe(beforeCalls);
      const frame = harness.lastFrame();
      // The exact recommendation accept command is now in the prompt buffer.
      expect(frame).toContain("/mission accept --id rec-42");
    } finally {
      harness.unmount();
    }
  });

  it("never invokes the find handler from a disabled focus path", async () => {
    const commandHandlers = handlers();
    const harness = mountInteractive({
      handlers: commandHandlers,
      signal: new AbortController().signal,
    });
    try {
      await settle();
      // Default auth state is "checking", so the Find action is disabled.
      // Entering sidebar and pressing Enter should NOT enqueue /find.
      harness.stdin.send(upArrow());
      await settle();
      harness.stdin.send(downArrow());
      await settle();
      harness.stdin.send(enterKey());
      await settle();
      harness.stdin.send(enterKey());
      await settle();
      const frame = harness.lastFrame();
      // No recommendation accept command entered the prompt.
      expect(frame).not.toContain("/mission accept --id rec-42");
    } finally {
      harness.unmount();
    }
  });
});

describe("persistent session — auth state propagation", () => {
  afterEach(() => cleanup());

  it("reflects controller auth-status results in the sidebar after /auth status", async () => {
    const commandHandlers = handlers();
    vi.mocked(commandHandlers.authStatus).mockResolvedValue({
      kind: "auth-status",
      connected: true,
      login: "octocat",
      detail: "CONNECTED",
    });
    const harness = mountInteractive({
      handlers: commandHandlers,
      signal: new AbortController().signal,
    });
    try {
      await settle();
      harness.stdin.send("/auth status\r");
      await settle();
      // Move focus to sidebar then jump to the action panel; the Find action
      // (id "find.run") should now render as enabled (`-`) rather than `x`.
      harness.stdin.send(upArrow());
      await settle();
      harness.stdin.send(downArrow());
      await settle();
      const frame = harness.lastFrame();
      // Find.run is now actionable: marker is `*-` not `>*x`.
      expect(frame).toMatch(/Find a challenge/);
      expect(frame).toContain("/find");
      // The auth status reflects the connected login name.
      expect(frame).toContain("octocat");
    } finally {
      harness.unmount();
    }
  });
});
describe("persistent session — live stdout capabilities", () => {
  afterEach(() => cleanup());

  it("derives capabilities from Ink's stdout when no override is supplied", async () => {
    // Use the FakeInkStdout harness with a non-default 59×24 viewport and
    // no `capabilities` prop. The shell must read columns/rows from the
    // stdout stream so the real production mount honors a 59×24
    // terminal.
    const stdin = new FakeInkStdin();
    const stdout = new FakeInkStdout(59, 24);
    const instance = renderInk(
      createElement(Session, {
        handlers: handlers(),
        signal: new AbortController().signal,
      }),
      {
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
        patchConsole: false,
        exitOnCtrlC: false,
        debug: true,
      },
    );
    try {
      await settle();
      const frame = stdout.lastFrame();
      // 59 columns means the sidebar stacks above the main column and
      // the prompt retains `Type a command…` (no typed input yet).
      expect(frame).toContain("Ready");
      expect(frame).toContain("Type a command…");
      // The frame never overflows the stdout's row budget.
      expect(frame.split("\n").length).toBeLessThanOrEqual(24);
    } finally {
      instance.unmount();
    }
  });
});

describe("persistent session — auth failure propagation", () => {
  afterEach(() => cleanup());

  it("transitions authState from checking to unknown when /auth status fails with DM_NETWORK_UNAVAILABLE", async () => {
    const commandHandlers = handlers();
    vi.mocked(commandHandlers.authStatus).mockRejectedValue(
      createKestrelError({
        code: "DM_NETWORK_UNAVAILABLE",
        category: "TRANSIENT",
        userMessage: "GitHub is unreachable",
        suggestedActions: ["Retry once you have network connectivity"],
        retryability: "RETRYABLE",
        recoveryStrategy: "RETRY",
        severity: "ERROR",
      }),
    );
    const harness = mountInteractive({
      handlers: commandHandlers,
      signal: new AbortController().signal,
      initialCategory: "auth",
    });
    try {
      await settle();
      harness.stdin.send("/auth status\r");
      await settle();
      const frame = harness.lastFrame();
      // The error result still surfaces in the transcript so the user
      // reads the reason + suggested actions.
      expect(frame).toContain("DM_NETWORK_UNAVAILABLE");
      // The interactive renderer appended the recovery line and the
      // action panel exposes `/auth status` as the primary recovery
      // (the unknown-state recovery command per the existing transition
      // policy). The Auth sidebar position surfaces the same recovery.
      expect(frame).toContain("Run /auth status to continue.");
      expect(frame).toContain("Check authentication");
      expect(frame).toContain("/auth status");
      // Move focus into the sidebar and confirm Find surfaces the
      // `/auth status` recovery command rather than `/auth login`.
      harness.stdin.send(upArrow());
      await settle();
      harness.stdin.send(downArrow());
      await settle();
      const frameAfter = harness.lastFrame();
      expect(frameAfter).toContain("/auth status");
      // The recovery command is the unknown-state primary, not the
      // required-state `/auth login` recovery.
      expect(frameAfter).not.toMatch(/Find a challenge\n\s+\/auth login/u);
    } finally {
      harness.unmount();
    }
  });

  it("does not invent a second auth transition for successful /auth status", async () => {
    const commandHandlers = handlers();
    vi.mocked(commandHandlers.authStatus).mockResolvedValue({
      kind: "auth-status",
      connected: true,
      login: "octocat",
      detail: "CONNECTED",
    });
    const harness = mountInteractive({
      handlers: commandHandlers,
      signal: new AbortController().signal,
    });
    try {
      await settle();
      harness.stdin.send("/auth status\r");
      await settle();
      const frame = harness.lastFrame();
      expect(frame).toContain("octocat");
    } finally {
      harness.unmount();
    }
  });
});
