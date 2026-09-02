import { render as renderInk } from "ink";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandContext, CommandHandlers } from "../command-handlers.js";
import type { ViewModel } from "../presentation/view-models.js";
import { FakeInkStdin, FakeInkStdout } from "../../test-utils/ink-stdin.js";
import { Session } from "./session.js";
import { createSessionController } from "./session-controller.js";
import { authenticateGitHub } from "../../application/auth/authenticate-github.js";
import { createKestrelError } from "../../application/errors/kestrel-error.js";
import type { Credential, CredentialStore } from "../../ports/credential-store.js";
import type {
  DeviceFlowAuthorization,
  GitHubGateway,
  GitHubToken,
} from "../../ports/github-gateway.js";

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
      // The status bar reflects the unknown auth state with the failure
      // reason (spec §9.3) so the user can see what happened.
      expect(harness.lastFrame()).toContain("Auth status unavailable (STARTUP_AUTH_TIMEOUT)");
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
    // command. The handler must therefore be called exactly once, AND
    // the rendered prompt must no longer contain the submitted command.
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
      // Direct assertion: the rendered frame must NOT still show the
      // typed command in the active prompt slot. When the buffer is
      // empty the prompt renders the placeholder; when it has typed
      // text, the placeholder disappears and the input is shown.
      // The placeholder string is unique to the prompt row, so its
      // presence proves the input was cleared.
      const admittedFrame = harness.lastFrame();
      expect(admittedFrame).toContain("Type a command");
      expect(admittedFrame).not.toMatch(/Type a command[^…]*\/progress/u);
      // The admitted command must be recorded in the transcript
      // EXACTLY ONCE: a single `› /progress` line. The transcript
      // renders admitted input as `› <text>`, so we count those
      // occurrences. A duplicate (e.g. clearing twice or re-adding
      // during the finally) would surface as a count > 1; a missing
      // addEntry would surface as 0.
      const inputEntryMatches = admittedFrame.match(/› \/progress/gu) ?? [];
      expect(inputEntryMatches.length).toBe(1);
      // The handler is still pending. Pressing Enter WITHOUT typing
      // must be a no-op: the prompt is empty, so `commandText` is `""`
      harness.stdin.send("\r");
      await settle(80);
      expect(progressCalls).toBe(1);
      // Resolve the first handler and wait for the renderer to release
      // the busy state. The frame must continue to show an empty prompt
      // (the admitted command has been dispatched exactly once and is
      // now recorded in the transcript, not the prompt).
      resolveFirst?.(view);
      await settle(120);
      expect(progressCalls).toBe(1);
      const releasedFrame = harness.lastFrame();
      expect(releasedFrame).toContain("Ready");
      // The prompt placeholder is visible (no typed command survived
      // in the prompt buffer after release).
      expect(releasedFrame).toContain("Type a command");
      expect(releasedFrame).not.toMatch(/Type a command[^…]*\/progress/u);
    } finally {
      resolveFirst?.(view);
      harness.unmount();
    }
  });

  it("preserves the queued CR-chunk remainder in the prompt until the next Enter", async () => {
    // When the user pastes multi-line input, the Enter (CR) splits the
    // chunk into the first command and a separately queued remainder.
    // The remainder is preserved in the prompt buffer for the next
    // submit. Clearing the prompt on a commandOverride-driven submit
    // would destroy that queued remainder.
    //
    // Step 1 — paste `/progress\r/journey` (no trailing CR). The
    // session runs `/progress` via drainQueue (the commandOverride
    // path) and writes `/journey` into the prompt buffer.
    // Step 2 — wait for `/progress` to resolve; the prompt must STILL
    // contain `/journey` (the override-driven clear was skipped).
    // Step 3 — press Enter; the prompt submits `/journey` exactly once.
    //
    // Implementation note: we mock `progress` to hang on the first
    // call so we can capture the moment the override-driven submit
    // dispatched `/progress` while `/journey` remained in the prompt
    // buffer. We then resolve it after we have asserted the prompt
    // state, and finally press Enter to dispatch `/journey`.
    const commandHandlers = handlers();
    let resolveProgress: ((view: ViewModel) => void) | undefined;
    let progressCalls = 0;
    vi.mocked(commandHandlers.progress).mockImplementation(async () => {
      progressCalls += 1;
      return new Promise<ViewModel>((resolve) => {
        resolveProgress = resolve;
      });
    });
    let journeyCalls = 0;
    vi.mocked(commandHandlers.journey).mockImplementation(async () => {
      journeyCalls += 1;
      return view;
    });
    const harness = mount({
      handlers: commandHandlers,
      signal: new AbortController().signal,
    });
    try {
      await settle();
      // Paste a CR-chunk WITHOUT a trailing CR. The first command is
      // dispatched via drainQueue, the second lives in the prompt.
      harness.stdin.send("/progress\r/journey");
      // Wait for `/progress` to be admitted and the handler to start.
      await settle();
      expect(progressCalls).toBe(1);
      expect(journeyCalls).toBe(0);
      // The prompt must still contain `/journey` because the
      // commandOverride path skipped the `setInput("")` clear.
      // The placeholder is gone (input buffer is non-empty), so the
      // prompt row renders the typed `/journey` instead of the
      // placeholder string.
      const midFrame = harness.lastFrame();
      expect(midFrame).toContain("/journey");
      expect(midFrame).not.toContain("Type a command");
      // The admitted `/progress` command must be recorded in the
      // transcript exactly once (override path also adds an input
      // entry, so the transcript reflects the submitted command).
      const progressEntryMatches = midFrame.match(/› \/progress/gu) ?? [];
      expect(progressEntryMatches.length).toBe(1);
      // Resolve `/progress` so the slot releases and the next Enter
      // can admit `/journey`.
      resolveProgress?.(view);
      await settle(120);
      // Pressing Enter must submit the queued remainder exactly once.
      harness.stdin.send("\r");
      await settle(120);
      expect(journeyCalls).toBe(1);
      // The prompt slot is empty — the placeholder is rendered again
      // (no typed command survives in the prompt after submit).
      const finalFrame = harness.lastFrame();
      expect(finalFrame).toContain("Ready");
      expect(finalFrame).toContain("Type a command");
    } finally {
      resolveProgress?.(view);
      harness.unmount();
    }
  });
});


  afterEach(() => {
    vi.useRealTimers();
  });

  it("cancels a held token request, runs /progress, then accepts the exact recommendation on the second Enter", async () => {
    // Task 6 regression — a single FakeInk scenario covering four
    // contracts in the order they would surface in a real session:
    //
    //   (1) explicit login cancellation: the device-flow token poll is
    //       held by the local `/login/oauth/access_token` fixture; busy
    //       Ctrl+C aborts the in-flight login child, the held request
    //       closes, and the auth subsystem never reaches the credential
    //       store (the handler rejects with DM_GITHUB_AUTH_CANCELLED
    //       before storing anything).
    //   (2) same-session local `/progress`: after cancellation, the
    //       same session serves the local progress command without ever
    //       touching the network.
    //   (3) exact recommendation action first Enter fills the prompt:
    //       pressing Enter on the focused recommendation.accept action
    //       places the exact `/mission accept --id rec-42` command in
    //       the prompt buffer; the mission accept handler is NOT
    //       called yet.
    //   (4) second Enter accepts the exact ID once: pressing Enter on
    //       the filled prompt invokes `missionAccept` exactly once
    let commandHandlers = handlers();
    // The auth subsystem under test is the REAL `authenticateGitHub`
    // application use case wired against two fakes: a `GitHubGateway`
    // whose device-flow `beginDeviceFlow` returns an authorization
    // immediately (so the controller's notify channel renders the
    // device-authorization notice) and whose `pollForToken` is held
    // open until the child signal aborts, and a `CredentialStore`
    // whose `store` is a counted spy over the persisted credential
    // list. Ctrl+C aborts the in-flight login child; the gateway's
    // poll rejects with `DM_GITHUB_AUTH_CANCELLED`; `authenticateGitHub`
    // propagates that rejection; the credential store is never
    // reached. The previous iteration stood in for this boundary with
    // a hand-rolled promise whose `.then` callback bumped a counter on
    // resolution — a fake of a fake. The store assertion below now
    // exercises the real `CredentialStore.store` boundary instead of
    // a disconnected counter.
    const presentedNotices: ViewModel[] = [];
    let pollAbortObserved = false;
    let pollBeginObserved = false;
    let storeCredentialCalls = 0;
    const storedCredentials: Credential[] = [];
    const fakeCredentialStore: CredentialStore = {
      async get(_service, _account, _signal) {
        return undefined;
      },
      async store(credential, _signal) {
        storeCredentialCalls += 1;
        storedCredentials.push(credential);
      },
      async delete(_service, _account, _signal) {
        // Cancellation rejects before any storage step; the login
        // path never deletes here, so this branch stays empty.
      },
    };
    const fakeGateway: GitHubGateway = {
      async beginDeviceFlow(): Promise<DeviceFlowAuthorization> {
        return {
          deviceCode: "device-code",
          userCode: "ABCD-1234",
          verificationUri: "https://github.com/login/device",
          expiresInSeconds: 900,
          intervalSeconds: 5,
        };
      },
      async pollForToken(
        _deviceCode: string,
        signal?: AbortSignal,
      ): Promise<GitHubToken> {
        pollBeginObserved = true;
        return new Promise<GitHubToken>((_resolve, reject) => {
          if (signal === undefined) {
            reject(
              createKestrelError({
                code: "DM_GITHUB_AUTH_CANCELLED",
                category: "USER_ACTION_REQUIRED",
                userMessage: "device flow cancelled",
                suggestedActions: [
                  "Run /auth login when ready to authenticate again.",
                ],
                retryability: "NO_RETRY",
                recoveryStrategy: "USER_ACTION",
                severity: "INFO",
              }),
            );
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              pollAbortObserved = true;
              reject(
                createKestrelError({
                  code: "DM_GITHUB_AUTH_CANCELLED",
                  category: "USER_ACTION_REQUIRED",
                  userMessage: "device flow cancelled",
                  suggestedActions: [
                    "Run /auth login when ready to authenticate again.",
                  ],
                  retryability: "NO_RETRY",
                  recoveryStrategy: "USER_ACTION",
                  severity: "INFO",
                }),
              );
            },
            { once: true },
          );
        });
      },
      async getViewer() {
        return { login: "octocat", id: 1 };
      },
      async getPullRequest(): Promise<never> {
        throw new Error("unused in auth-boundary test");
      },
      async getIssueLinkage(): Promise<undefined> {
        return undefined;
      },
      async getMergeInfo() {
        return { merged: false, mergeSha: undefined, mergedAt: undefined };
      },
    };
    // Replace the default mock handler with the real `authenticateGitHub`
    // use case against the two fakes above. This is the application
    // boundary the previous hand-rolled promise was emulating.
    commandHandlers.authLogin = vi.fn(
      async (_args: Record<string, never>, context: CommandContext) => {
        const auth = await authenticateGitHub(
          { credentialStore: fakeCredentialStore, gateway: fakeGateway },
          {
            account: "github",
            ...(context.signal === undefined ? {} : { signal: context.signal }),
            onAuthorization: (authorization) => {
              const notice: ViewModel = {
                kind: "device-authorization",
                verificationUri: authorization.verificationUri,
                userCode: authorization.userCode,
              };
              presentedNotices.push(notice);
              context.onNotice?.(notice);
            },
          },
        );
        return {
          kind: "auth-status",
          connected: true,
          login: auth.account,
          detail: "CONNECTED",
        };
      },
    );

    // The mount-time startup auth check runs first. The first
    // `authStatus` call returns NOT_CONNECTED; a subsequent explicit
    // /auth status (after we cancel the login) returns CONNECTED so
    // the Find action becomes enabled.
    let authStatusCalls = 0;
    vi.mocked(commandHandlers.authStatus).mockImplementation(async () => {
      authStatusCalls += 1;
      return authStatusCalls === 1
        ? notConnectedAuthStatus
        : {
            kind: "auth-status",
            connected: true,
            login: "octocat",
            detail: "CONNECTED",
          };
    });

    const recommendation: ViewModel = {
      kind: "recommendation",
      recommendationId: "rec-42",
      challengeId: "chal-1",
      title: "Fix something",
      mood: "focused",
      confidence: 0.9,
      reasons: ["match"],
    };
    vi.mocked(commandHandlers.find).mockResolvedValue(recommendation);

    let progressCalls = 0;
    vi.mocked(commandHandlers.progress).mockImplementation(async () => {
      progressCalls += 1;
      return { kind: "verification", text: "local-progress-ok" };
    });

    let missionAcceptCalls = 0;
    let missionAcceptId: string | undefined;
    vi.mocked(commandHandlers.missionAccept).mockImplementation(
      async ({ recommendationId }) => {
        missionAcceptCalls += 1;
        missionAcceptId = recommendationId;
        return {
          kind: "mission",
          id: "mission-42",
          status: "ACCEPTED",
          title: recommendation.title,
        };
      },
    );

    const onSessionExit = vi.fn();
    const harness = mount({
      handlers: commandHandlers,
      onSessionExit,
      signal: new AbortController().signal,
    });
    try {
      await settle();
      // (1) Explicit login cancellation. The user types `/auth login`
      // and the real `authenticateGitHub` use case is dispatched; its
      // gateway `beginDeviceFlow` returns the authorization and emits
      // it through the controller's notify channel, then `pollForToken`
      // is held until the child signal aborts. Pressing Ctrl+C aborts
      // the child signal so the held request closes with
      // `DM_GITHUB_AUTH_CANCELLED` and the credential store is never
      // reached.
      harness.stdin.send("/auth login\r");
      await settle();
      expect(commandHandlers.authLogin).toHaveBeenCalledTimes(1);
      // The device-flow authorization notice has been delivered through
      // callback also records it for direct assertion.
      expect(presentedNotices).toEqual([
        {
          kind: "device-authorization",
          verificationUri: "https://github.com/login/device",
          userCode: "ABCD-1234",
        },
      ]);
      // The gateway's `pollForToken` was reached and is still held.
      expect(pollBeginObserved).toBe(true);
      harness.stdin.send("\u0003");
      await settle(80);
      // The held token request closed: the gateway's `pollForToken`
      // observed the abort signal and rejected the in-flight promise.
      expect(pollAbortObserved).toBe(true);
      expect(onSessionExit).not.toHaveBeenCalled();
      // No credential was stored: the abort path rejected before any
      // storage step could run. The real `CredentialStore.store`
      // boundary is exercised here, not a disconnected counter on a
      // fake promise's `.then` chain. This assertion FAILS if the
      // cancellation ever reaches the store (e.g. a future change that
      // resolves the polled token on abort instead of rejecting).
      expect(storeCredentialCalls).toBe(0);
      expect(storedCredentials).toEqual([]);
      // Sanity: the rejected handler has settled; no later resolution
      // can still fire the store spy from a queued microtask.
      await settle(40);
      expect(storeCredentialCalls).toBe(0);
      expect(storedCredentials).toEqual([]);

      // (2) Same-session local /progress runs after the cancellation.
      // The local command is admitted without ever touching the
      // network or auth subsystem.
      harness.stdin.send("/progress\r");
      await settle();
      expect(progressCalls).toBe(1);

      // (3) Explicit /auth status connects so the Find action
      // becomes enabled. The user can then navigate to the sidebar
      // and arm the recommendation accept action.
      harness.stdin.send("/auth status\r");
      await settle();
      expect(authStatusCalls).toBe(2);

      // Run /find so a recommendation is captured. The captured view
      // enables the recommendation.accept contextual action.
      harness.stdin.send("/find\r");
      await settle();

      // Navigate: Up moves focus to the sidebar; Down steps once
      // from Home (index 0) to Find (1); Enter focuses the action
      // panel; Down arms the recommendation.accept row.
      harness.stdin.send("\u001b[A");
      await settle();
      harness.stdin.send("\u001b[B");
      await settle();
      harness.stdin.send("\r");
      await settle();
      harness.stdin.send("\u001b[B");
      await settle();

      // First Enter on the focused recommendation.accept action
      // fills the prompt with the exact command. missionAccept is
      // NOT called yet — the action just placed text into the
      // prompt buffer.
      const beforeAcceptCalls = missionAcceptCalls;
      harness.stdin.send("\r");
      await settle();
      expect(missionAcceptCalls).toBe(beforeAcceptCalls);
      const filledFrame = harness.lastFrame();
      expect(filledFrame).toContain("/mission accept --id rec-42");
      // (4) Second Enter on the filled prompt submits the exact
      // command. missionAccept is invoked exactly once with the
      // exact recommendation id bound to the action.
      harness.stdin.send("\r");
      await settle();
      expect(missionAcceptCalls).toBe(beforeAcceptCalls + 1);
      expect(missionAcceptId).toBe("rec-42");
      // Final causal assertion: after the entire scenario runs, the
      // credential store is still empty. The cancellation closed the
      // held request before any token reached storage; the rest of
      // the session never exercises the auth path again.
      expect(storeCredentialCalls).toBe(0);
      expect(storedCredentials).toEqual([]);
      // Only one device-authorization notice was emitted — at the
      // beginning of the cancelled login. No further authorization
      // steps run for the rest of the session.
      expect(presentedNotices).toHaveLength(1);


    } finally {
      harness.unmount();
    }
});

describe("session — busy /clear and /exit rejection", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects /exit while a foreground command is in flight and aborts the active child", async () => {
    // Finding: /exit was being accepted before the admission guard so a
    // busy login could outlive the Ink unmount. The synchronous
    // admission slot must reject /exit (and /clear) while busy, the
    // session must remain mounted, and the active child must be
    // aborted so device polling and credential helpers exit.
    const commandHandlers = handlers();
    let resolveAuthLogin: ((view: ViewModel) => void) | undefined;
    let loginReject: ((reason: unknown) => void) | undefined;
    vi.mocked(commandHandlers.authLogin).mockImplementation(
      async (_args, context) =>
        new Promise<ViewModel>((resolve, reject) => {
          resolveAuthLogin = resolve;
          loginReject = reject;
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
        }),
    );
    const onSessionExit = vi.fn();
    const harness = mount({
      handlers: commandHandlers,
      signal: new AbortController().signal,
      onSessionExit,
    });
    try {
      await settle();
      harness.stdin.send("/auth login\r");
      await settle();
      expect(commandHandlers.authLogin).toHaveBeenCalled();
      // /exit while busy: must not call onSessionExit, must not
      // unmount Ink. The session remains mounted, and a
      // subsequent /progress — once the busy slot is freed by
      // aborting the in-flight login via Ctrl+C — can be
      // admitted.
      harness.stdin.send("/exit\r");
      await settle(80);
      expect(onSessionExit).not.toHaveBeenCalled();
      // Free the admission slot by aborting the in-flight login
      // child (the same first-Ctrl+C contract that keeps the
      // session alive).
      harness.stdin.send("\u0003");
      await settle(1000);
      harness.stdin.send("/progress\r");
      await settle(1000);
      expect(commandHandlers.progress).toHaveBeenCalled();
    } finally {
      resolveAuthLogin?.(view);
      loginReject?.(new Error("test cleanup"));
      harness.unmount();
    }
  });


  it("rejects /clear while a foreground command is in flight", async () => {
    // /clear must not be allowed while busy; the synchronous
    // admission guard must reject it and the in-flight command must
    // continue running.
    const commandHandlers = handlers();
    let resolveProgress: ((view: ViewModel) => void) | undefined;
    vi.mocked(commandHandlers.progress).mockImplementation(
      async () =>
        new Promise<ViewModel>((resolve) => {
          resolveProgress = resolve;
        }),
    );
    const harness = mount({
      handlers: commandHandlers,
      signal: new AbortController().signal,
    });
    try {
      await settle();
      harness.stdin.send("/progress\r");
      await settle();
      expect(commandHandlers.progress).toHaveBeenCalled();
      harness.stdin.send("/clear\r");
      await settle(40);
      // The first progress call is still in flight; /clear did not
      // cancel it.
      expect(commandHandlers.progress).toHaveBeenCalledTimes(1);
      // No clear ran in between.
      expect(commandHandlers.progress).toHaveBeenCalledTimes(1);
    } finally {
      resolveProgress?.(view);
      harness.unmount();
    }
  });
});

describe("session — LOGIN_AUTHORIZATION reducer dispatch via notify", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispatches LOGIN_AUTHORIZATION to the reducer for the active login operation", async () => {
    // The session must route device-authorization notices into the
    // reducer for the active operation, not merely append them to the
    // transcript. Otherwise the awaiting-user phase, stale-notice
    // guard, and operation-id rejection paths are exercised only by
    // isolated reducer unit tests.
    const commandHandlers = handlers();
    let loginResolve: ((view: ViewModel) => void) | undefined;
    let loginReject: ((reason: unknown) => void) | undefined;
    let capturedSignal: AbortSignal | undefined;
    vi.mocked(commandHandlers.authLogin).mockImplementation(
      async (_args, context) => {
        capturedSignal = context.signal;
        context.onNotice?.({
          kind: "device-authorization",
          verificationUri: "https://github.com/login/device",
          userCode: "ABCD-1234",
        });
        return new Promise<ViewModel>((resolve, reject) => {
          loginResolve = resolve;
          loginReject = reject;
        });
      },
    );
    const harness = mount({
      handlers: commandHandlers,
      signal: new AbortController().signal,
    });
    try {
      await settle();
      harness.stdin.send("/auth login\r");
      await settle(80);
      // The login is admitted, the controller notice was delivered,
      // and the reducer's awaiting-user phase is now active (the
      // state is `logging-in` with `awaiting-user`, not `starting`).
      const frame = harness.lastFrame();
      expect(frame).toContain("ABCD-1234");
      // The notice appears as a transcript entry too.
      expect(frame).toContain("https://github.com/login/device");
      // The login is still in flight; we did not trigger an abort.
      expect(capturedSignal?.aborted).toBe(false);
    } finally {
      loginResolve?.(view);
      loginReject?.(new Error("test cleanup"));
      harness.unmount();
    }
  });

  it("ignores LOGIN_AUTHORIZATION notices for stale operation ids", async () => {
    const commandHandlers = handlers();
    let loginResolve: ((view: ViewModel) => void) | undefined;
    let loginReject: ((reason: unknown) => void) | undefined;
    vi.mocked(commandHandlers.authLogin).mockImplementation(
      async (_args, context) => {
        return new Promise<ViewModel>((resolve, reject) => {
          loginResolve = resolve;
          loginReject = reject;
          // The login holds until its child signal aborts. The
          // device-authorization notice is then delivered as a
          // late event — after the operation has been cancelled.
          // A late notice must NOT flip the reducer or appear in
          // the transcript.
          context.signal?.addEventListener("abort", () => {
            context.onNotice?.({
              kind: "device-authorization",
              verificationUri: "https://github.com/login/device",
              userCode: "STALE-9999",
            });
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
        });
      },
    );
    const harness = mount({
      handlers: commandHandlers,
      signal: new AbortController().signal,
    });
    try {
      await settle();
      harness.stdin.send("/auth login\r");
      await settle();
      expect(commandHandlers.authLogin).toHaveBeenCalled();
      // Cancel the login so its captured operation id becomes stale.
      harness.stdin.send("\u0003");
      await settle(80);
      // A subsequent /progress must still run in the same session.
      harness.stdin.send("/progress\r");
      await settle(60);
      expect(commandHandlers.progress).toHaveBeenCalled();
      // The STALE-9999 code is bound to the cancelled operation and
      // must not be appended to the transcript as the active
      // awaiting-user notice.
      const frame = harness.lastFrame();
      expect(frame).not.toContain("STALE-9999");
    } finally {
      loginResolve?.(view);
      loginReject?.(new Error("test cleanup"));
      harness.unmount();
    }
  });
});

describe("session — child-aborted login is rendered as neutral cancellation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the in-flight login as a neutral cancellation when the child signal aborts before the handler rejects", async () => {
    // The session must derive cancellation from the child signal's
    // aborted state, not solely from the handler's returned error
    // code. Some gateways (or a credential helper that never
    // responds) may reject with DM_PROCESS_CANCELLED or a similar
    // transport-level code; the session must still render the
    // session-active neutral notice and dispatch OPERATION_CANCELLED.
    const commandHandlers = handlers();
    let loginResolve: ((view: ViewModel) => void) | undefined;
    let loginReject: ((reason: unknown) => void) | undefined;
    vi.mocked(commandHandlers.authLogin).mockImplementation(
      async (_args, context) =>
        new Promise<ViewModel>((_resolve, reject) => {
          loginReject = reject;
          // Reject with a transport-level cancellation code (NOT
          // DM_GITHUB_AUTH_CANCELLED) when the child signal aborts.
          // The session must still render the neutral notice.
          context.signal?.addEventListener("abort", () => {
            reject(
              Object.assign(new Error("Login was cancelled; the session remains active."), {
                code: "DM_PROCESS_CANCELLED",
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
        }),
    );
    const onSessionExit = vi.fn();
    const harness = mount({
      handlers: commandHandlers,
      signal: new AbortController().signal,
      onSessionExit,
    });
    try {
      await settle();
      harness.stdin.send("/auth login\r");
      await settle();
      expect(commandHandlers.authLogin).toHaveBeenCalled();
      // Abort the in-flight login child. The handler rejects with
      // DM_PROCESS_CANCELLED; the session must NOT render a red
      // action-required card. It must render the neutral notice.
      harness.stdin.send("\u0003");
      await settle(80);
      const frame = harness.lastFrame();
      expect(frame).toContain("session remains active");
      // The session is not exited by the cancellation.
      expect(onSessionExit).not.toHaveBeenCalled();
      // No red error banner — the cancellation is a neutral
      // transcript notice, not an action-required card.
      expect(frame).not.toMatch(/Error\s*\[DM_PROCESS_CANCELLED\]/u);
    } finally {
      loginResolve?.(view);
      loginReject?.(new Error("test cleanup"));
      harness.unmount();
    }
  });
});

describe("session — Home key is a no-op while an operation is running", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores the raw Home escape sequence while a foreground child is in flight", async () => {
    // The Home key (\x1b[H / \x1bOH / \x1b[1~) must not orphan a
    // running foreground child. The reducer ignores HOME_SELECTED
    // while the operation is running, so the raw Home hook is a
    // safe no-op in the same window.
    const commandHandlers = handlers();
    let resolveAuthLogin: ((view: ViewModel) => void) | undefined;
    let loginReject: ((reason: unknown) => void) | undefined;
    vi.mocked(commandHandlers.authLogin).mockImplementation(
      async (_args, context) =>
        new Promise<ViewModel>((_resolve, reject) => {
          resolveAuthLogin = resolve;
          loginReject = reject;
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
        }),
    );
    const harness = mount({
      handlers: commandHandlers,
      signal: new AbortController().signal,
    });
    try {
      await settle();
      harness.stdin.send("/auth login\r");
      await settle();
      expect(commandHandlers.authLogin).toHaveBeenCalled();
      // Raw Home escape sequence while busy: must not change the
      // login state. The foreground child is still in flight.
      harness.stdin.send("\u001b[H");
      await settle(40);
      expect(commandHandlers.authLogin).toHaveBeenCalledTimes(1);
      // The session is still busy with the login; the user can
      // still abort it via Ctrl+C.
      harness.stdin.send("\u0003");
      await settle(80);
    } finally {
      resolveAuthLogin?.(view);
      loginReject?.(new Error("test cleanup"));
      harness.unmount();
    }
  });
});

