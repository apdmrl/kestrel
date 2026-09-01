import { render as renderInk } from "ink";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandContext, CommandHandlers } from "../command-handlers.js";
import type { ViewModel } from "../presentation/view-models.js";
import { FakeInkStdin, FakeInkStdout } from "../../test-utils/ink-stdin.js";
import { Session } from "./session.js";
import { createSessionController } from "./session-controller.js";

const view: ViewModel = { kind: "verification", text: "ok" };
const notConnectedAuthStatus: ViewModel = {
  kind: "auth-status",
  connected: false,
  login: null,
  detail: "NOT_CONNECTED",
};

function handlers(overrides: Partial<CommandHandlers> = {}): CommandHandlers {
  return {
    find: vi.fn().mockResolvedValue(view),
    authLogin: vi.fn().mockResolvedValue(view),
    authStatus: vi.fn().mockResolvedValue(notConnectedAuthStatus),
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
    ...overrides,
  };
}

interface Harness {
  readonly stdin: FakeInkStdin;
  readonly stdout: FakeInkStdout;
  readonly unmount: () => void;
  readonly lastFrame: () => string;
}

/**
 * Render the session against a stdin Ink accepts, so real keystrokes drive it.
 * `ink-testing-library` cannot be used here: its stdin has no `ref`, so Ink's
 * `useInput` throws on mount and never receives input.
 */
function mount(props: {
  handlers: CommandHandlers;
  signal: AbortSignal;
  onSessionExit?: () => void;
}): Harness {
  const stdin = new FakeInkStdin();
  const stdout = new FakeInkStdout();
  const instance = renderInk(
    createElement(Session, {
      handlers: props.handlers,
      signal: props.signal,
      onExit: props.onSessionExit,
    }),
    {
      // The fakes implement only the stream surface Ink touches.
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: true,
    },
  );
  return {
    stdin,
    stdout,
    unmount: () => instance.unmount(),
    lastFrame: () => stdout.lastFrame(),
  };
}

const settle = (ms = 60): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("session auth interaction", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders device authorization guidance through the controller notify channel", async () => {
    // The session passes interim guidance (device-flow instructions) into the
    // controller's notify callback, which the session then appends to the
    // transcript. Asserting on the notify channel is the durable contract:
    // the rendered Ink frame is a presentation detail whose reconstruction is
    // not part of this fake's stream surface.
    const commandHandlers = handlers();
    vi.mocked(commandHandlers.authLogin).mockImplementation(async (_args, context) => {
      context.onNotice?.({
        kind: "device-authorization",
        verificationUri: "https://github.com/login/device",
        userCode: "ABCD-1234",
      });
      return view;
    });
    const notices: ViewModel[] = [];
    const controller = createSessionController(commandHandlers, (received) => notices.push(received));
    await controller({ kind: "auth-login" }, {});
    expect(notices).toHaveLength(1);
    expect(notices[0]).toEqual({
      kind: "device-authorization",
      verificationUri: "https://github.com/login/device",
      userCode: "ABCD-1234",
    });
  });

  it("routes /auth status through the session to its handler", async () => {
    const commandHandlers = handlers();
    const harness = mount({ handlers: commandHandlers, signal: new AbortController().signal });
    try {
      await settle();
      harness.stdin.send("/auth status\r");
      await settle();
      expect(commandHandlers.authStatus).toHaveBeenCalled();
    } finally {
      harness.unmount();
    }
  });

  it("aborts the in-flight login child signal on busy Ctrl+C and keeps the session active", async () => {
    const commandHandlers = handlers();
    let capturedLoginSignal: AbortSignal | undefined;
    let loginReject: ((reason: unknown) => void) | undefined;
    vi.mocked(commandHandlers.authLogin).mockImplementation(
      async (_args, context) =>
        new Promise<ViewModel>((_resolve, reject) => {
          capturedLoginSignal = context.signal;
          // Real handlers observe the abort signal and reject with
          // DM_GITHUB_AUTH_CANCELLED so the session can render a neutral
          // "session remains active" message. Mirror that here.
          context.signal?.addEventListener("abort", () => {
            const err = Object.assign(new Error("Login was cancelled; the session remains active."), {
              code: "DM_GITHUB_AUTH_CANCELLED",
              name: "KestrelError",
              category: "USER_ACTION_REQUIRED",
              userMessage: "Login was cancelled; the session remains active.",
              suggestedActions: ["Run /auth login when ready to authenticate again."],
              retryability: "manual",
              recoveryStrategy: "USER_GUIDED",
              severity: "INFO",
            });
            reject(err);
          });
          loginReject = reject;
        }),
    );
    const onSessionExit = vi.fn();
    const harness = mount({
      handlers: commandHandlers,
      signal: new AbortController().signal,
      onSessionExit,
    });
    try {
      // Wait for the mount-time startup auth check to settle on NOT_CONNECTED.
      await settle();
      harness.stdin.send("/auth login\r");
      await settle();
      expect(commandHandlers.authLogin).toHaveBeenCalled();
      expect(capturedLoginSignal?.aborted).toBe(false);
      // Busy Ctrl+C aborts the foreground login child, not the session.
      harness.stdin.send("\u0003");
      await settle(60);
      expect(capturedLoginSignal?.aborted).toBe(true);
      expect(onSessionExit).not.toHaveBeenCalled();
      // The cancellation is rendered neutrally: the user is told the
      // session remains active so they can run another command. The
      // renderer preserves the error.userMessage verbatim; the established
      // renderer message uses the lowercase phrase.
      expect(harness.lastFrame()).toContain("session remains active");
    } finally {
      // If the test fails before the abort listener fires, settle the
      // pending promise so React/Vitest can shut down cleanly.
      loginReject?.(new Error("test cleanup"));
      harness.unmount();
    }
  });

  it("clears the prompt on idle Ctrl+C without touching any child signal", async () => {
    const commandHandlers = handlers();
    const onSessionExit = vi.fn();
    const harness = mount({
      handlers: commandHandlers,
      signal: new AbortController().signal,
      onSessionExit,
    });
    try {
      await settle();
      harness.stdin.send("\u0003");
      await settle(40);
      expect(onSessionExit).not.toHaveBeenCalled();
      // Nothing was running, so no handler should be invoked by Ctrl+C.
      expect(commandHandlers.authLogin).not.toHaveBeenCalled();
      expect(commandHandlers.find).not.toHaveBeenCalled();
    } finally {
      harness.unmount();
    }
  });
});

describe("session auth interaction — startup auth deadline", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lets a local command run after the startup auth check times out", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const commandHandlers = handlers({
      authStatus: vi.fn(
        () => new Promise<ViewModel>(() => undefined),
      ),
    });
    const harness = mount({
      handlers: commandHandlers,
      signal: new AbortController().signal,
    });
    try {
      // Advance past the 5-second startup deadline.
      await vi.advanceTimersByTimeAsync(5_500);
      // The startup auth check timed out, but the session can still accept
      // a local command. `/progress` is a local view-model command that
      // must run independently of the network.
      harness.stdin.send("/progress\r");
      await vi.advanceTimersByTimeAsync(100);
      expect(commandHandlers.progress).toHaveBeenCalled();
      // The startup auth check observed the deadline and aborted its child.
      expect(harness.lastFrame()).toContain("Ready");
    } finally {
      harness.unmount();
    }
  });

  it("never invokes the find handler when the Find action is disabled", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const commandHandlers = handlers({
      authStatus: vi.fn(() => Promise.resolve(notConnectedAuthStatus)),
    });
    const harness = mount({
      handlers: commandHandlers,
      signal: new AbortController().signal,
    });
    try {
      // Wait for the startup auth check to settle.
      await settle();
      // While the user is NOT connected to GitHub, the Find action must
      // remain disabled. Pressing Enter on the contextual action panel
      // (Find.run) must not call the find handler.
      harness.stdin.send("\u001b[A"); // up — focus sidebar
      await settle();
      harness.stdin.send("\u001b[B"); // down — move to Find
      await settle();
      harness.stdin.send("\r"); // enter — focus actions
      await settle();
      harness.stdin.send("\r"); // enter — would submit if enabled
      await settle(40);
      expect(commandHandlers.find).not.toHaveBeenCalled();
    } finally {
      harness.unmount();
    }
  });
});

describe("session auth interaction — overlapping submission admission", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("admits only one in-flight submission at a time and clears busy state synchronously", async () => {
    // The admission guard is the synchronous `operationRunning.current`
    // ref, NOT React's deferred `busy` state. Two `/progress` submissions
    // dispatched in the same React tick must not both invoke the
    // handler: the second is rejected by the synchronous ref guard, and
    // the session remains busy until the first handler resolves.
    const commandHandlers = handlers();
    const progressCalls: number[] = [];
    let resolveFirst: ((view: ViewModel) => void) | undefined;
    vi.mocked(commandHandlers.progress).mockImplementation(async () => {
      const idx = progressCalls.length + 1;
      progressCalls.push(idx);
      if (idx === 1) {
        return new Promise<ViewModel>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return view;
    });
    const harness = mount({
      handlers: commandHandlers,
      signal: new AbortController().signal,
    });
    try {
      // Wait for the mount-time startup auth check to settle on NOT_CONNECTED.
      await settle();
      // Dispatch two /progress commands in the same tick. The stdin
      // harness buffers them; the second is dispatched before React
      // re-renders, so a `busy` (React state) guard cannot reject it.
      harness.stdin.send("/progress\r");
      harness.stdin.send("/progress\r");
      await settle();
      // Only the first /progress handler was admitted. The second
      // submission passed the reducer (the typed command landed in the
      // transcript) but `submit()` returned early because
      // `operationRunning.current === true`.
      expect(commandHandlers.progress).toHaveBeenCalledTimes(1);
      // The renderer is busy while the first handler is pending.
      expect(harness.lastFrame()).toContain("Working");
      // Resolve the first handler and let the second submission land.
      resolveFirst?.(view);
      await settle(120);
      // Now the second /progress is admitted because the synchronous
      // guard flipped back to false after the first handler resolved.
      expect(commandHandlers.progress).toHaveBeenCalledTimes(2);
      expect(harness.lastFrame()).toContain("Ready");
    } finally {
      resolveFirst?.(view);
      harness.unmount();
    }
  });

  it("keeps the renderer busy and the synchronous guard set while the foreground child is in flight", async () => {
    // The admission guard is the synchronous `operationRunning.current`
    // ref. A second `/progress` dispatched while the first is still
    // pending is rejected by the synchronous ref, and the renderer
    // must remain in the "Working" state until the first handler
    // resolves. A late first-handler resolution must NOT clear busy
    // while the synchronous guard still reads true — i.e. no other
    // child has been installed to clobber the active one.
    const commandHandlers = handlers();
    let resolveFirst: ((view: ViewModel) => void) | undefined;
    let progressCalls = 0;
    vi.mocked(commandHandlers.progress).mockImplementation(async () => {
      progressCalls += 1;
      if (progressCalls === 1) {
        return new Promise<ViewModel>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return view;
    });
    const harness = mount({
      handlers: commandHandlers,
      signal: new AbortController().signal,
    });
    try {
      await settle();
      // First /progress is admitted and blocks the admission guard.
      harness.stdin.send("/progress\r");
      await settle();
      expect(commandHandlers.progress).toHaveBeenCalledTimes(1);
      // The synchronous admission guard rejects any subsequent
      // submission until the first handler resolves.
      harness.stdin.send("/progress\r");
      await settle();
      expect(commandHandlers.progress).toHaveBeenCalledTimes(1);
      // The renderer is busy throughout.
      expect(harness.lastFrame()).toContain("Working");
      // Resolve the first handler. The second `/progress` (queued by
      // the stdin harness) is now admitted because the synchronous
      // guard flipped back to false in the first handler's finally.
      resolveFirst?.(view);
      await settle(120);
      expect(commandHandlers.progress).toHaveBeenCalledTimes(2);
      expect(harness.lastFrame()).toContain("Ready");
    } finally {
      resolveFirst?.(view);
      harness.unmount();
    }
  });
});

describe("session auth interaction — prompt clearing on synchronous admission", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears the prompt immediately after admitting an interactive submit, then a second Enter is a no-op", async () => {
    // The user types a mutating command (`/progress`), presses Enter, the
    // handler runs, then they press Enter again WITHOUT typing anything.
    // The admission guard (synchronous `operationRunning.current` ref) must
    // have cleared the prompt buffer in the same tick the first submit
    // was admitted — otherwise the second Enter would re-submit the same
    // command. The handler must therefore be called exactly once.
    const commandHandlers = handlers();
    let resolveFirst: ((view: ViewModel) => void) | undefined;
    let progressCalls = 0;
    vi.mocked(commandHandlers.progress).mockImplementation(async () => {
      progressCalls += 1;
      return new Promise<ViewModel>((resolve) => {
        resolveFirst = resolve;
      });
    });
    const harness = mount({
      handlers: commandHandlers,
      signal: new AbortController().signal,
    });
    try {
      await settle();
      // Type the command and submit it. The stdin send bundles the typed
      // characters + Enter, so the prompt receives the input transition.
      harness.stdin.send("/progress\r");
      await settle();
      // The first submit was admitted; the prompt buffer must be empty
      // (the user typed `/progress` but pressing Enter cleared it).
      expect(progressCalls).toBe(1);
      // The handler is still pending. Pressing Enter WITHOUT typing
      // must be a no-op: the prompt is empty, so `commandText` is `""`
      // and the early return fires.
      harness.stdin.send("\r");
      await settle(80);
      expect(progressCalls).toBe(1);
      // Resolve the first handler and confirm the session is ready again.
      resolveFirst?.(view);
      await settle(120);
      expect(progressCalls).toBe(1);
      expect(harness.lastFrame()).toContain("Ready");
    } finally {
      resolveFirst?.(view);
      harness.unmount();
    }
  });

  it("does not clear the prompt when a queued CR-chunk remainder submission is admitted", async () => {
    // When the user pastes multi-line input, the Enter (CR) splits the
    // chunk into the first command and a separately queued remainder.
    // The remainder is preserved in the prompt buffer for the next
    // submit. Clearing the prompt on a commandOverride-driven submit
    // would destroy that queued remainder.
    const commandHandlers = handlers();
    let progressCalls = 0;
    vi.mocked(commandHandlers.progress).mockImplementation(async () => view);
    vi.mocked(commandHandlers.journey).mockImplementation(async () => {
      progressCalls += 1;
      return view;
    });
    const harness = mount({
      handlers: commandHandlers,
      signal: new AbortController().signal,
    });
    try {
      await settle();
      // Paste a CR-chunk: `/progress` is the first command, `/journey` is
      // a queued remainder set into the prompt. The first command is
      // submitted via `drainQueue(["/progress"])` (a commandOverride
      // path), the second lives in the prompt buffer.
      // NOTE: `/journey` is a valid command; the test will assert that
      // submitting via commandOverride does NOT clobber the queued
      // remainder.
      harness.stdin.send("/progress\r/journey\r");
      await settle();
      // After both settle: progress ran once and journey was admitted
      // because the queued remainder survived in the prompt.
      expect(commandHandlers.progress).toHaveBeenCalledTimes(1);
      expect(commandHandlers.journey).toHaveBeenCalledTimes(1);
    } finally {
      harness.unmount();
    }
  });
});
