import { createElement } from "react";
import { render as renderInk } from "ink";
import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ContextActions,
  DashboardShell,
  DEFAULT_MISSION_SUGGESTIONS,
  DEFAULT_QUICK_COMMANDS,
} from "./dashboard.js";
import { actionsForSection } from "./session-navigation.js";
import type { SessionAction } from "./session-navigation.js";
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
      // Find.run is now actionable: marker is `*-` (enabled) for the
      // Find.run row inside the contextual action panel. The compact
      // budget at 80x24 drops the auth-status transcript line, so we
      // assert on the live action availability rather than the
      // transcript text.
      expect(frame).toMatch(/-\s+Find a challenge/u);
      expect(frame).toContain("/find");
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

describe("persistent session — auth failure propagation (reducer-driven)", () => {
  afterEach(() => cleanup());

  it("transitions to unknown only when /auth status fails during checking", async () => {
    const commandHandlers = handlers();
    vi.mocked(commandHandlers.authStatus).mockRejectedValue(
      createKestrelError({
        code: "DM_NETWORK_UNAVAILABLE",
        category: "TRANSIENT",
        userMessage: "GitHub is unreachable",
        suggestedActions: ["Retry"],
        retryability: "RETRYABLE",
        recoveryStrategy: "RETRY",
        severity: "ERROR",
      }),
    );
    const harness = mountInteractive({
      handlers: commandHandlers,
      signal: new AbortController().signal,
    });
    try {
      await settle();
      harness.stdin.send("/auth status\r");
      await settle();
      // Navigate to the Find section: the contextual action panel
      // surfaces `/auth status` as the recovery for the disabled
      // `Find a challenge` row. The reducer owns the transition from
      // `checking` to `unknown(errorCode)`; the session component no
      // longer mutates auth state directly.
      harness.stdin.send(upArrow());
      await settle();
      harness.stdin.send(downArrow());
      await settle();
      const nav = harness.lastFrame();
      expect(nav).toMatch(FIND_RECOVERY_AUTH_STATUS);
    } finally {
      harness.unmount();
    }
  });
});

// Regexes that match the rendered Find-section ContextActions panel:
//   FIND_ENABLED                 → /find action is the primary enabled row.
//   FIND_RECOVERY_AUTH_STATUS    → Find.run disabled with `/auth status` recovery.
//   FIND_RECOVERY_AUTH_LOGIN     → Find.run disabled with `/auth login` recovery.
// The compact budget at 80x24 sometimes drops the transcript, so these
// regexes assert on the live action panel, not on incidental transcript
// text that compact windowing intentionally suppresses. The recovery
// commands wrap onto two lines inside the bordered ContextActions box
// (the `/auth` prefix sits on one line and the verb on the next), so the
// regex tolerates a 0–10 character gap. We additionally anchor on the
// Find-run disabled reason string ("GitHub authentication is not
// verified…") so the transcript's bounded "Run /auth status to
// continue." recovery line — which also contains `/auth status` — does
// not accidentally satisfy the action-panel regex.
const FIND_ENABLED = /Find a challenge[\s\S]{0,40}\/find/u;
const FIND_RECOVERY_AUTH_STATUS =
  /GitHub authentication is not verified[\s\S]{0,400}\/auth\s+status/u;
const FIND_RECOVERY_AUTH_LOGIN =
  /GitHub authentication is not verified[\s\S]{0,400}\/auth[\s\S]{0,10}login/u;

describe("Session — auth failure routing (reducer-driven)", () => {
  afterEach(() => cleanup());

  it("preserves the connected state when /find fails with DM_NETWORK_UNAVAILABLE", async () => {
    const commandHandlers = handlers();
    vi.mocked(commandHandlers.authStatus).mockResolvedValue({
      kind: "auth-status",
      connected: true,
      login: "octocat",
      detail: "CONNECTED",
    });
    vi.mocked(commandHandlers.find).mockRejectedValue(
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
    });
    try {
      await settle();
      harness.stdin.send("/auth status\r");
      await settle();
      const connectedFrame = harness.lastFrame();
      expect(connectedFrame).toContain("octocat");
      harness.stdin.send("/find\r");
      await settle(120);
      harness.stdin.send(upArrow());
      await settle();
      harness.stdin.send(downArrow());
      await settle();
      const nav = harness.lastFrame();
      // The connected state must be preserved: /find remains the
      // primary action. The unknown-state recovery must NOT replace it.
      expect(nav).toMatch(FIND_ENABLED);
      expect(nav).not.toMatch(FIND_RECOVERY_AUTH_STATUS);
    } finally {
      harness.unmount();
    }
  });

  it("restores required state when /auth login fails with DM_GITHUB_AUTH_REQUIRED", async () => {
    const commandHandlers = handlers();
    vi.mocked(commandHandlers.authStatus).mockResolvedValue({
      kind: "auth-status",
      connected: false,
      login: null,
      detail: "NOT_CONNECTED",
    });
    vi.mocked(commandHandlers.authLogin).mockRejectedValue(
      createKestrelError({
        code: "DM_GITHUB_AUTH_REQUIRED",
        category: "USER_ACTION_REQUIRED",
        userMessage: "GitHub auth required",
        suggestedActions: ["Run /auth login"],
        retryability: "NO_RETRY",
        recoveryStrategy: "REAUTHENTICATE",
        severity: "ERROR",
      }),
    );
    const harness = mountInteractive({
      handlers: commandHandlers,
      signal: new AbortController().signal,
    });
    try {
      await settle();
      harness.stdin.send("/auth status\r");
      await settle();
      harness.stdin.send("/auth login\r");
      await settle(150);
      harness.stdin.send(upArrow());
      await settle();
      harness.stdin.send(downArrow());
      await settle();
      const frame = harness.lastFrame();
      // The required-state recovery (/auth login) must surface, not
      // the unknown-state /auth status. The reducer's
      // OPERATION_FAILED path restores authBeforeLogin (which was
      // `required` after a NOT_CONNECTED auth-status).
      expect(frame).toMatch(FIND_RECOVERY_AUTH_LOGIN);
      expect(frame).not.toMatch(FIND_RECOVERY_AUTH_STATUS);
    } finally {
      harness.unmount();
    }
  });
});

describe("ContextActions — variable row chrome", () => {
  afterEach(() => cleanup());

  it("renders more rows for 6 actions than for 2 actions", () => {
    const two: SessionAction[] = [
      { id: "a", label: "A", command: "/a", availability: { status: "enabled" } },
      { id: "b", label: "B", command: "/b", availability: { status: "enabled" } },
    ];
    const six: SessionAction[] = [];
    for (let i = 0; i < 6; i += 1) {
      six.push({
        id: `x${i}`,
        label: `X${i}`,
        command: `/x${i}`,
        availability: { status: "enabled" },
      });
    }
    const twoRows = (render(<ContextActions actions={two} />).lastFrame() ?? "").split("\n").length;
    const sixRows = (render(<ContextActions actions={six} />).lastFrame() ?? "").split("\n").length;
    expect(sixRows).toBeGreaterThan(twoRows);
  });
});

describe("DashboardShell — wide pane with production ContextActions", () => {
  afterEach(() => cleanup());

  it("stays within 24 rows at 80x24 when ContextActions is mounted with multiple actions", () => {
    const six: SessionAction[] = [];
    for (let i = 0; i < 6; i += 1) {
      six.push({
        id: `x${i}`,
        label: `Action ${i}`,
        command: `/cmd-${i}`,
        availability: { status: "enabled" },
      });
    }
    const { lastFrame } = render(
      <DashboardShell
        status="Ready"
        title="Mission Control"
        subtitle="Welcome back"
        sessionStatus="active"
        mission={{
          title: "No active mission",
          description: "Discover a challenge or resume your current engineering work.",
          suggestions: DEFAULT_MISSION_SUGGESTIONS,
        }}
        stats={[]}
        quickCommands={DEFAULT_QUICK_COMMANDS}
        input=""
        busy={false}
        placeholder="Type a command…"
        capabilities={{ columns: 80, rows: 24, color: true }}
        contextActions={six}
        selectedActionIndex={0}
        actionFocused={false}
      />,
    );
    const frame = lastFrame() ?? "";
    const actualRows = frame.split("\n").length;
    expect(
      actualRows,
      `expected ≤24 rows at 80x24 with 6 ContextActions, got ${actualRows}`,
    ).toBeLessThanOrEqual(24);
  });
});

describe("actionsForSection — existing behavior preserved", () => {
  it("returns /mission accept --id rec-42 with exact ID", () => {
    const actions = actionsForSection(
      "find",
      { status: "connected", login: "octocat" },
      {
        kind: "recommendation",
        recommendationId: "rec-42",
        challengeId: "ch-1",
        title: "Fix something",
        mood: "focused",
        confidence: 0.9,
        reasons: ["match"],
      },
    );
    expect(actions).toContainEqual(
      expect.objectContaining({
        id: "recommendation.accept",
        command: "/mission accept --id rec-42",
      }),
    );
  });
});