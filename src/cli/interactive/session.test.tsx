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

  it("keeps exactly one visible focus owner", async () => {
    const harness = mountInteractive({
      handlers: handlers(),
      signal: new AbortController().signal,
      capabilities: { columns: 80, rows: 24, color: true },
    });
    try {
      await settle();
      harness.stdin.send(downArrow());
      await settle();
      harness.stdin.send(downArrow());
      await settle();
      const sidebarFrame = harness.lastFrame();
      expect((sidebarFrame.match(/>/gu) ?? [])).toHaveLength(1);
      expect(sidebarFrame).toMatch(/>\*-\s+Find/u);
      expect(sidebarFrame).not.toMatch(/>\*-\s+Find a challenge/u);

      harness.stdin.send(enterKey());
      await settle();
      const actionsFrame = harness.lastFrame();
      expect((actionsFrame.match(/>/gu) ?? [])).toHaveLength(1);
      expect(actionsFrame).toMatch(/>\*x\s+Find a challenge/u);
      expect(actionsFrame).not.toMatch(/>\*-\S+\s+Find/u);
    } finally {
      harness.unmount();
    }
  });

  it.each([
    { columns: 59, rows: 24 },
    { columns: 80, rows: 19 },
  ])("compact navigation shows the focused section at $columns×$rows", async ({ columns, rows }) => {
    const harness = mountInteractive({
      handlers: handlers(),
      signal: new AbortController().signal,
      capabilities: { columns, rows, color: true },
    });
    try {
      await settle();
      harness.stdin.send(downArrow());
      await settle();
      expect(harness.lastFrame()).toMatch(/>\*-\s+Home/u);
      expect(harness.lastFrame()).toContain("↑↓ move");
    } finally {
      harness.unmount();
    }
  });

  it("keeps the prompt row stable while moving through action sections", async () => {
    const harness = mountInteractive({
      handlers: handlers(),
      signal: new AbortController().signal,
      capabilities: { columns: 80, rows: 24, color: true },
    });
    try {
      await settle();
      harness.stdin.send("/progress\r");
      await settle();
      harness.stdin.send(downArrow());
      await settle();
      const frames = [harness.lastFrame()];
      for (let index = 0; index < 3; index += 1) {
        harness.stdin.send(downArrow());
        await settle();
        frames.push(harness.lastFrame());
      }
      const heights = frames.map((frame) => frame.split("\n").length);
      const promptRows = frames.map((frame) =>
        frame.split("\n").findIndex((line) => line.includes("Type a command…")),
      );
      expect(new Set(heights).size).toBe(1);
      expect(new Set(promptRows).size).toBe(1);
      expect(frames.at(-1)).toContain("Create handoff");
      expect(frames.at(-1)).toContain("› /progress");
    } finally {
      harness.unmount();
    }
  });

  it("returns navigation home without cancelling a running operation", async () => {
    const commandHandlers = handlers();
    let complete: ((result: ViewModel) => void) | undefined;
    let operationSignal: AbortSignal | undefined;
    vi.mocked(commandHandlers.progress).mockImplementation((_args, context) => {
      operationSignal = context.signal;
      return new Promise<ViewModel>((resolve) => {
        complete = resolve;
      });
    });
    const harness = mountInteractive({
      handlers: commandHandlers,
      signal: new AbortController().signal,
      capabilities: { columns: 80, rows: 24, color: true },
    });
    try {
      await settle();
      harness.stdin.send("/progress\r");
      await settle();
      expect(harness.lastFrame()).toContain("Working…");
      expect(operationSignal?.aborted).toBe(false);

      harness.stdin.send(downArrow());
      await settle();
      harness.stdin.send(downArrow());
      await settle();
      expect(harness.lastFrame()).toMatch(/>\*-\s+Find/u);

      harness.stdin.send("\u001b[H");
      await settle();
      const homeFrame = harness.lastFrame();
      expect(homeFrame).toMatch(/\s\*-\s+Home/u);
      expect(homeFrame).not.toMatch(/>\*-\s+Home/u);
      expect(homeFrame).toContain("Working…");
      expect(operationSignal?.aborted).toBe(false);
      expect(commandHandlers.progress).toHaveBeenCalledTimes(1);

      if (complete === undefined) throw new Error("progress operation did not start");
      complete(view);
      await settle();
      expect(harness.lastFrame()).not.toContain("Working…");
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
  it("removes stale accept action after empty Find", async () => {
    const commandHandlers = handlers();
    vi.mocked(commandHandlers.authStatus).mockResolvedValue({
      kind: "auth-status",
      connected: true,
      login: "octocat",
      detail: "CONNECTED",
    });
    vi.mocked(commandHandlers.find)
      .mockResolvedValueOnce({
        kind: "recommendation",
        recommendationId: "rec-42",
        challengeId: "chal-1",
        title: "Fix something",
        mood: "focused",
        confidence: 0.9,
        reasons: ["match"],
      })
      .mockResolvedValueOnce({ kind: "verification", text: "No challenge found" });
    const harness = mountInteractive({
      handlers: commandHandlers,
      signal: new AbortController().signal,
      capabilities: { columns: 100, rows: 60, color: true },
    });
    try {
      await settle();
      harness.stdin.send("/auth status\r");
      await settle();
      harness.stdin.send("/find\r");
      await settle();
      harness.stdin.send(upArrow());
      await settle();
      harness.stdin.send(downArrow());
      await settle();
      expect(harness.lastFrame()).toContain("/mission accept --id rec-42");
      harness.stdin.send(enterKey());
      await settle();
      harness.stdin.send(enterKey());
      await settle();
      harness.stdin.send(enterKey());
      await settle();
      const afterFrame = harness.lastFrame();
      expect(afterFrame).toContain("No challenge found");
      expect(afterFrame).not.toContain("/mission accept --id rec-42");
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
  it("drops the recommendation accept action after a successful mission accept", async () => {
    // Behavioral test for Finding 3: after `/mission accept --id <id>`
    // returns a mission view, the reducer clears `latestRecommendation`
    // (session-state.ts OPERATION_SUCCEEDED mission branch), and the
    // contextual action panel must surface that change. The exact
    // `/mission accept --id rec-42` action must disappear from the
    // Find panel once the mission is accepted. The session must also
    // surface the exact accept action BEFORE acceptance so we are not
    // asserting on a permanent removal — only on removal AFTER the
    // mission accept succeeds.
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
    let missionAcceptCalls = 0;
    let capturedRecommendationId: string | undefined;
    vi.mocked(commandHandlers.missionAccept).mockImplementation(
      async ({ recommendationId }) => {
        missionAcceptCalls += 1;
        capturedRecommendationId = recommendationId;
        return {
          kind: "mission",
          id: "mission-42",
          status: "ACCEPTED",
          title: "Fix something",
        };
      },
    );
    const harness = mountInteractive({
      handlers: commandHandlers,
      signal: new AbortController().signal,
    });
    try {
      await settle();
      // Connect and load a recommendation so the Find action panel
      // gains the exact recommendation.accept row.
      harness.stdin.send("/auth status\r");
      await settle();
      harness.stdin.send("/find\r");
      await settle();
      // Focus sidebar (Up from prompt), step to Find (Down from Home),
      // Enter the action panel (Enter on sidebar), then Down arms the
      // recommendation.accept row.
      harness.stdin.send(upArrow());
      await settle();
      harness.stdin.send(downArrow());
      await settle();
      // Sanity: BEFORE acceptance, the exact accept action is rendered
      // on the Find panel. If this fails, the test scaffolding is wrong
      // (the recommendation did not survive into the panel) and we
      // cannot trust the post-acceptance assertion.
      const beforeFrame = harness.lastFrame();
      expect(beforeFrame).toContain("/mission accept --id rec-42");
      harness.stdin.send(enterKey());
      await settle();
      harness.stdin.send(downArrow());
      await settle();
      // First Enter on the focused recommendation.accept action fills
      // the prompt with the exact command; missionAccept is not called
      // yet.
      harness.stdin.send(enterKey());
      await settle();
      expect(missionAcceptCalls).toBe(0);
      // Second Enter submits the filled prompt — missionAccept runs
      // once with the exact recommendation id bound to the action.
      harness.stdin.send(enterKey());
      await settle();
      expect(missionAcceptCalls).toBe(1);
      expect(capturedRecommendationId).toBe("rec-42");
      // The session is back at the prompt (the action-panel return
      // handler focused the prompt when the first Enter filled the
      // typed command, and the second Enter submitted it). The
      // contextual action panel still renders the still-selected
      // Find category, so it directly reflects whatever
      // `latestRecommendation` the panel was last fed. The reducer
      // cleared `latestRecommendation` on the OPERATION_SUCCEEDED
      // mission branch; the panel must reflect that and stop
      // rendering the stale exact `/mission accept --id rec-42`
      // row. The submitted command is already echoed in the
      // immutable transcript, so a correct reducer-driven panel
      // would surface the string exactly once. A stale local mirror
      // would surface it twice (transcript echo + action-panel
      // row), which is the RED signal.
      const afterFrame = harness.lastFrame();
      const occurrenceCount = (
        afterFrame.match(/\/mission\s+accept\s+--id\s+rec-42/gu) ?? []
      ).length;
      expect(occurrenceCount).toBe(1);
    } finally {
      harness.unmount();
    }
  });
  it("does not submit the prompt when Enter is pressed with sidebar focused on Home (empty prompt)", async () => {
    // Regression test for Finding 4: pressing Enter while the sidebar is
    // focused on Home must NOT fall through to `submit()`. Home exposes
    // zero contextual actions, so the generic sidebar-Enter branch is
    // skipped and the current code falls through to `void submit()`. With
    // an empty prompt `submit()` is a no-op (it returns before any handler
    // runs) so the only observable failure is that the sidebar keeps focus
    // on Home instead of returning it to the prompt.
    const commandHandlers = handlers();
    const harness = mountInteractive({
      handlers: commandHandlers,
      signal: new AbortController().signal,
    });
    try {
      await settle();
      // Move focus from the prompt into the sidebar (Home is index 0 by
      // default). The sidebar must show the focused marker on Home before
      // we press Enter — otherwise the scaffolding missed the focus
      // transition and the test would silently assert on the wrong state.
      harness.stdin.send(upArrow());
      await settle();

      const beforeFrame = harness.lastFrame();
      expect(beforeFrame).toMatch(HOME_FOCUSED);
      // Press Enter with sidebar focused on Home. No command handler is
      // invoked and the prompt stays empty.
      const beforeCalls = vi.mocked(commandHandlers.progress).mock.calls.length;
      harness.stdin.send(enterKey());
      await settle();
      const afterCalls = vi.mocked(commandHandlers.progress).mock.calls.length;
      expect(afterCalls).toBe(beforeCalls);
      const afterFrame = harness.lastFrame();
      // Focus must move back to the prompt: the sidebar Home row no longer
      // carries the `>` focus marker. It still shows `*-` because Home is
      // the selected category.
      expect(afterFrame).not.toMatch(HOME_FOCUSED);
      expect(afterFrame).toMatch(HOME_SELECTED);
      // No transcript command entry appeared.
      expect(afterFrame).not.toContain("› /");
    } finally {
      harness.unmount();
    }
  });
  it("does not submit the prompt when Enter is pressed with sidebar focused on Home (nonempty prompt)", async () => {
    // Companion to the empty-prompt case above. With a typed command
    // pre-filled in the prompt the current fallthrough dispatches it
    // through `submit()`, calling the matching handler. The fix must
    // short-circuit the Home sidebar Enter BEFORE `submit()` runs, so a
    // typed `/progress` never reaches the controller. The prompt is
    // cleared through the reducer's HOME_SELECTED event so a stale
    // `/progress` is not re-submitted by the next Enter.
    const commandHandlers = handlers();
    const harness = mountInteractive({
      handlers: commandHandlers,
      signal: new AbortController().signal,
      initialInput: "/progress",
    });
    try {
      await settle();
      // Move focus to sidebar (Home).
      harness.stdin.send(upArrow());
      await settle();
      const beforeFrame = harness.lastFrame();
      expect(beforeFrame).toMatch(HOME_FOCUSED);
      expect(beforeFrame).toContain("/progress");
      // Press Enter: no command handler should run.
      const beforeCalls = vi.mocked(commandHandlers.progress).mock.calls.length;
      harness.stdin.send(enterKey());
      await settle();
      const afterCalls = vi.mocked(commandHandlers.progress).mock.calls.length;
      expect(afterCalls).toBe(beforeCalls);
      const afterFrame = harness.lastFrame();
      // Focus returned to the prompt: the focused sidebar marker on
      // Home is gone.
      expect(afterFrame).not.toMatch(HOME_FOCUSED);
      // The typed command was cleared through the reducer's
      // HOME_SELECTED event, so a stray `/progress` is not echoed in
      // the prompt or transcript.
      expect(afterFrame).not.toContain("/progress");
    } finally {
      harness.unmount();
    }
  });
  it("clears the latest recommendation when Enter is pressed with sidebar focused on Home", async () => {
    // Companion to the two Home-Enter cases above. A loaded
    // recommendation surfaces `/mission accept --id rec-42` in the
    // Find action panel. Pressing Home Enter while focus is on the
    // sidebar dispatches HOME_SELECTED, which clears
    // `latestRecommendation` through the reducer — so the contextual
    // action panel stops surfacing the stale accept command.
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
      // Connect and capture a recommendation so the Find action panel
      // surfaces the exact accept command.
      harness.stdin.send("/auth status\r");
      await settle();
      harness.stdin.send("/find\r");
      await settle();
      // Navigate to Find to confirm the recommendation.accept action is
      // rendered before pressing Home Enter — otherwise the scaffolding
      // missed the capture and we cannot trust the post-clear assertion.
      harness.stdin.send(upArrow());
      await settle();
      harness.stdin.send(downArrow());
      await settle();
      const findFrame = harness.lastFrame();
      expect(findFrame).toContain("/mission accept --id rec-42");
      // Step back to Home (Up from Find index 1 → Home index 0) before
      // pressing Home Enter. The Home sidebar Enter is the event under
      // test, not the Find sidebar Enter (which already routes into
      // the action panel).
      harness.stdin.send(upArrow());
      await settle();
      const homeFrame = harness.lastFrame();
      expect(homeFrame).toMatch(HOME_FOCUSED);
      // Press Enter: no command handler runs and the reducer clears
      // `latestRecommendation`.
      const beforeCalls = vi.mocked(commandHandlers.missionAccept).mock.calls.length;
      harness.stdin.send(enterKey());
      await settle();
      const afterCalls = vi.mocked(commandHandlers.missionAccept).mock.calls.length;
      // Home Enter must return focus to the prompt. Navigate back into
      // the sidebar to inspect the Find panel and prove the reducer
      // cleared `latestRecommendation` — not just that focus left Home.
      // Step 1: Down from prompt focuses Home (sidebar index 0).
      harness.stdin.send(downArrow());
      await settle();
      const homeFrameAfter = harness.lastFrame();
      expect(homeFrameAfter).toMatch(HOME_FOCUSED);
      // Step 2: Down again moves the sidebar focus to Find (index 1).
      // The Find action panel must NOT surface the exact accept command
      // any more — a correct HOME_SELECTED cleared it through the
      // reducer, so the contextual action panel reads from a null
      // recommendation.
      harness.stdin.send(downArrow());
      await settle();
      const findFrameAfter = harness.lastFrame();
      expect(findFrameAfter).toMatch(FIND_FOCUSED);
      expect(findFrameAfter).not.toContain("/mission accept --id rec-42");
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

describe("persistent session — logout transitions to required", () => {
  afterEach(() => cleanup());

  it("dispatches AUTH_RESOLVED disconnected after a successful /auth logout", async () => {
    const commandHandlers = handlers();
    // Both the mount-time startup auth check AND the explicit
    // /auth status call must observe a CONNECTED result so the user can
    // navigate to the Find section with the action panel enabled.
    vi.mocked(commandHandlers.authStatus).mockResolvedValueOnce({
      kind: "auth-status",
      connected: true,
      login: "octocat",
      detail: "CONNECTED",
    });
    vi.mocked(commandHandlers.authStatus).mockResolvedValueOnce({
      kind: "auth-status",
      connected: true,
      login: "octocat",
      detail: "CONNECTED",
    });
    // The successful logout returns an auth-status view with detail "LOGGED_OUT"
    // and connected=false; the controller is the existing contract.
    vi.mocked(commandHandlers.authLogout).mockResolvedValue({
      kind: "auth-status",
      connected: false,
      login: null,
      detail: "LOGGED_OUT",
    });
    const harness = mountInteractive({
      handlers: commandHandlers,
      signal: new AbortController().signal,
    });
    try {
      await settle();
      harness.stdin.send("/auth status\r");
      await settle();
      // The session is now `connected`; the Find action panel should
      // surface the enabled `-` marker for Find.run.
      harness.stdin.send(upArrow());
      await settle();
      harness.stdin.send(downArrow());
      await settle();
      const connectedFrame = harness.lastFrame();
      expect(connectedFrame).toMatch(FIND_ENABLED);
      // Now logout. The reducer must drop the connected state to
      // `required` so the live Find action flips back to the disabled
      // recovery path with `/auth login`.
      harness.stdin.send("/auth logout --confirm github.com\r");
      await settle(120);
      const logoutFrame = harness.lastFrame();
      // The Find.run row now exposes the required-state recovery; the
      // connected marker must no longer be present.
      expect(logoutFrame).not.toMatch(FIND_ENABLED);
      expect(commandHandlers.authLogout).toHaveBeenCalled();
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
    const commandHandlers = handlers();
    // The mount-time startup auth check needs a real auth-status view
    // so the reducer reaches a known-good state (connected) instead of
    // falling back to the "unknown" branch the spec reserves for
    // classification failures.
    vi.mocked(commandHandlers.authStatus).mockResolvedValue({
      kind: "auth-status",
      connected: true,
      login: "octocat",
      detail: "CONNECTED",
    });
    const instance = renderInk(
      createElement(Session, {
        handlers: commandHandlers,
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
// `FIND_ENABLED` anchors on the literal `*-` enabled marker immediately
// before the `Find a challenge` label so the disabled `>*x` row (which
// still renders the same `/find` command beneath the reason text) is
// not mistaken for an enabled action.
const FIND_ENABLED = /\*-\s+Find a challenge[\s\S]{0,40}\/find/u;
const FIND_RECOVERY_AUTH_STATUS =
  /GitHub authentication is not verified[\s\S]{0,400}\/auth\s+status/u;
const FIND_RECOVERY_AUTH_LOGIN =
  /GitHub authentication is not verified[\s\S]{0,400}\/auth[\s\S]{0,10}login/u;
// Regexes for the visible sidebar focus and selection markers. The label
// immediately follows its marker in compact and full layouts; the icon
// remains a trailing visual cue.
const HOME_FOCUSED = />\*-\s+Home/u;
const FIND_FOCUSED = />\*-\s+Find/u;
const HOME_SELECTED = /\*-\s+Home/u;

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

describe("Session — typed device-authorization propagation (metadata)", () => {
  afterEach(cleanup);

  it("retains an enterprise device-authorization URI + code inside the bounded frame under filler pressure", async () => {
    // Behavioral test for Finding 5: the session must propagate a
    // typed `device-authorization` view (with a non-github.com
    // verification URI) into the bounded transcript without relying
    // on a github.com-specific text regex. The Session delivers the
    // notification through the controller's `notify` channel; the
    // resulting entry is classified and bounded by metadata so the
    // exact enterprise URI and user code survive row-budget eviction.
    const verificationUri = "https://github.enterprise.example.com/login/device";
    const userCode = "WXYZ-9876";
    const commandHandlers = handlers();
    let loginReject: ((reason: unknown) => void) | undefined;
    vi.mocked(commandHandlers.authLogin).mockImplementation(async (_args, context) => {
      context.onNotice?.({
        kind: "device-authorization",
        verificationUri,
        userCode,
      });
      // Hold the handler open until the child signal aborts so the
      // session can be observed in the Working state — mirrors the
      // existing session-auth.test.tsx harness for device-flow
      // notices that are still in flight.
      return new Promise<ViewModel>((_resolve, reject) => {
        context.signal?.addEventListener("abort", () => {
          reject(
            Object.assign(new Error("Login was cancelled; the session remains active."), {
              code: "DM_GITHUB_AUTH_CANCELLED",
              name: "KestrelError",
              category: "USER_ACTION_REQUIRED",
              userMessage: "Login was cancelled; the session remains active.",
              suggestedActions: ["Run /auth login when ready to authenticate again."],
              retryability: "manual",
              recoveryStrategy: "USER_GUIDED",
              severity: "INFO",
            }),
          );
        });
        loginReject = reject;
      });
    });
    const harness = mountInteractive({
      handlers: commandHandlers,
      signal: new AbortController().signal,
      capabilities: { columns: 80, rows: 24, color: true },
    });
    try {
      await settle();
      // Trigger the device-flow notice.
      harness.stdin.send("/auth login\r");
      await settle();
      expect(commandHandlers.authLogin).toHaveBeenCalled();
      // Busy Ctrl+C aborts the in-flight login child. Enter alone is a
      // no-op while busy (the submit path returns early when
      // admissionSlot.current.running is true), so the login would
      // hang and the filler commands would never run.
      harness.stdin.send("\u0003");
      await settle(120);
      // Drive enough noncritical filler to force the bounded window
      // to evict the older transcript entries. Each `/progress` runs
      // a handler that returns a plain `verification` view, which is
      // noncritical and short — perfect for filling the budget.
      for (let i = 0; i < 12; i += 1) {
        harness.stdin.send("/progress\r");
        await settle(60);
      }
      // The filler handler must actually have been invoked the
      // intended number of times — otherwise the test scaffolding
      // missed the post-abort ready state and we cannot trust the
      // URI/code assertion that follows.
      expect(vi.mocked(commandHandlers.progress).mock.calls.length).toBeGreaterThanOrEqual(12);
      const frame = harness.lastFrame();
      // The exact enterprise URI and user code must survive the
      // bounded window. Without metadata-driven criticality, the
      // github.com-only regex would drop the device entry on the
      // floor under filler pressure.
      expect(frame).toContain(verificationUri);
      expect(frame).toContain(userCode);
      // Frame stays within the row budget.
      expect(frame.split("\n").length).toBeLessThanOrEqual(24);
    } finally {
      // If the test fails before the abort listener fires, settle
      // the pending promise so React/Vitest can shut down cleanly.
      loginReject?.(new Error("test cleanup"));
      harness.unmount();
    }
  });
});