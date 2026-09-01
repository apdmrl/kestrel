import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandContext, CommandHandlers } from "../command-handlers.js";
import type { ViewModel } from "../presentation/view-models.js";
import {
  createChildOperation,
  runStartupAuth,
  STARTUP_AUTH_TIMEOUT_MS,
} from "./session-runtime.js";
import type { SessionEvent } from "./session-state.js";

const verification: ViewModel = { kind: "verification", text: "ok" };

function handlers(overrides: Partial<CommandHandlers> = {}): CommandHandlers {
  return {
    find: vi.fn().mockResolvedValue(verification),
    authLogin: vi.fn().mockResolvedValue(verification),
    authStatus: vi.fn().mockResolvedValue(verification),
    authLogout: vi.fn().mockResolvedValue(verification),
    missionAccept: vi.fn().mockResolvedValue(verification),
    missionPrepare: vi.fn().mockResolvedValue(verification),
    missionResume: vi.fn().mockResolvedValue(verification),
    missionCurrent: vi.fn().mockResolvedValue(verification),
    missionComplete: vi.fn().mockResolvedValue(verification),
    missionBreakLock: vi.fn().mockResolvedValue(verification),
    missionAbandon: vi.fn().mockResolvedValue(verification),
    agentBrief: vi.fn().mockResolvedValue(verification),
    verifySubmission: vi.fn().mockResolvedValue(verification),
    verifyLink: vi.fn().mockResolvedValue(verification),
    verifyMerge: vi.fn().mockResolvedValue(verification),
    journey: vi.fn().mockResolvedValue(verification),
    progress: vi.fn().mockResolvedValue(verification),
    preferencesGet: vi.fn().mockResolvedValue(verification),
    preferencesSet: vi.fn().mockResolvedValue(verification),
    ...overrides,
  };
}

describe("STARTUP_AUTH_TIMEOUT_MS", () => {
  it("is exactly 5_000 milliseconds", () => {
    expect(STARTUP_AUTH_TIMEOUT_MS).toBe(5_000);
  });
});

describe("createChildOperation", () => {
  it("forwards parent abort to the child controller", () => {
    const parent = new AbortController();
    const child = createChildOperation(parent.signal);
    expect(child.controller.signal.aborted).toBe(false);
    parent.abort(new Error("lifetime"));
    expect(child.controller.signal.aborted).toBe(true);
    expect(child.controller.signal.reason).toBe(parent.signal.reason);
    child.dispose();
  });

  it("does not abort the child after dispose", () => {
    const parent = new AbortController();
    const child = createChildOperation(parent.signal);
    child.dispose();
    parent.abort(new Error("late"));
    expect(child.controller.signal.aborted).toBe(false);
  });

  it("aborts the child immediately when the parent is already aborted", () => {
    const parent = new AbortController();
    parent.abort(new Error("prerun"));
    const child = createChildOperation(parent.signal);
    expect(child.controller.signal.aborted).toBe(true);
    child.dispose();
  });
});

describe("runStartupAuth", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispatches AUTH_RESOLVED connected when the handler resolves with CONNECTED", async () => {
    vi.useFakeTimers();
    const authStatus = vi.fn().mockResolvedValue({
      kind: "auth-status",
      connected: true,
      login: "octocat",
      detail: "CONNECTED",
    });
    const events: SessionEvent[] = [];
    const run = runStartupAuth({
      handlers: handlers({ authStatus }),
      parentSignal: new AbortController().signal,
      attemptId: 1,
      dispatch: (event) => events.push(event),
    });
    await vi.runAllTimersAsync();
    await run;
    expect(events).toContainEqual({
      type: "AUTH_RESOLVED",
      attemptId: 1,
      detail: "CONNECTED",
      login: "octocat",
    });
  });

  it("dispatches AUTH_RESOLVED NOT_CONNECTED so the reducer can transition to required", async () => {
    vi.useFakeTimers();
    const authStatus = vi.fn().mockResolvedValue({
      kind: "auth-status",
      connected: false,
      login: null,
      detail: "NOT_CONNECTED",
    });
    const events: SessionEvent[] = [];
    const run = runStartupAuth({
      handlers: handlers({ authStatus }),
      parentSignal: new AbortController().signal,
      attemptId: 1,
      dispatch: (event) => events.push(event),
    });
    await vi.runAllTimersAsync();
    await run;
    expect(events).toContainEqual({
      type: "AUTH_RESOLVED",
      attemptId: 1,
      detail: "NOT_CONNECTED",
      login: null,
    });
  });

  it("dispatches AUTH_RESOLVED EXPIRED so the reducer can transition to expired", async () => {
    vi.useFakeTimers();
    const authStatus = vi.fn().mockResolvedValue({
      kind: "auth-status",
      connected: false,
      login: null,
      detail: "EXPIRED",
    });
    const events: SessionEvent[] = [];
    const run = runStartupAuth({
      handlers: handlers({ authStatus }),
      parentSignal: new AbortController().signal,
      attemptId: 1,
      dispatch: (event) => events.push(event),
    });
    await vi.runAllTimersAsync();
    await run;
    expect(events).toContainEqual({
      type: "AUTH_RESOLVED",
      attemptId: 1,
      detail: "EXPIRED",
      login: null,
    });
  });

  it("renders first and marks auth unknown at the five-second deadline", async () => {
    vi.useFakeTimers();
    const authStatus = vi.fn(
      () => new Promise<ViewModel>(() => undefined),
    );
    const events: SessionEvent[] = [];
    const run = runStartupAuth({
      handlers: handlers({ authStatus }),
      parentSignal: new AbortController().signal,
      attemptId: 1,
      dispatch: (event) => events.push(event),
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(events).toContainEqual({
      type: "AUTH_FAILED",
      attemptId: 1,
      errorCode: "STARTUP_AUTH_TIMEOUT",
    });
    await run;
  });

  it("settles when the deadline wins even if the handler ignores abort", async () => {
    vi.useFakeTimers();
    // The handler's promise never resolves and never observes the abort
    // signal — `runStartupAuth` must still settle so the reducer can
    // transition to `unknown` and the rest of the session can render.
    const authStatus = vi.fn(
      () => new Promise<ViewModel>(() => undefined),
    );
    const events: SessionEvent[] = [];
    const run = runStartupAuth({
      handlers: handlers({ authStatus }),
      parentSignal: new AbortController().signal,
      attemptId: 1,
      dispatch: (event) => events.push(event),
    });
    await vi.advanceTimersByTimeAsync(STARTUP_AUTH_TIMEOUT_MS);
    await run;
    expect(events.some((e) => e.type === "AUTH_FAILED")).toBe(true);
  });

  it("clears the deadline timer when the handler wins", async () => {
    vi.useFakeTimers();
    const authStatus = vi.fn().mockResolvedValue({
      kind: "auth-status",
      connected: true,
      login: "octocat",
      detail: "CONNECTED",
    });
    const events: SessionEvent[] = [];
    const run = runStartupAuth({
      handlers: handlers({ authStatus }),
      parentSignal: new AbortController().signal,
      attemptId: 1,
      dispatch: (event) => events.push(event),
    });
    await vi.advanceTimersByTimeAsync(50);
    await vi.runAllTimersAsync();
    await run;
    // No AUTH_FAILED was dispatched — the handler completed first.
    expect(events.some((e) => e.type === "AUTH_FAILED")).toBe(false);
    // Advancing past the deadline should NOT add an AUTH_FAILED now
    // because the timer was already cleared.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events.filter((e) => e.type === "AUTH_FAILED")).toHaveLength(0);
  });

  it("suppresses a late handler resolution after the deadline fires", async () => {
    vi.useFakeTimers();
    let resolveHandler: ((view: ViewModel) => void) | undefined;
    const authStatus = vi.fn(
      () =>
        new Promise<ViewModel>((resolve) => {
          resolveHandler = resolve;
        }),
    );
    const events: SessionEvent[] = [];
    const run = runStartupAuth({
      handlers: handlers({ authStatus }),
      parentSignal: new AbortController().signal,
      attemptId: 1,
      dispatch: (event) => events.push(event),
    });
    await vi.advanceTimersByTimeAsync(STARTUP_AUTH_TIMEOUT_MS);
    expect(events).toContainEqual({
      type: "AUTH_FAILED",
      attemptId: 1,
      errorCode: "STARTUP_AUTH_TIMEOUT",
    });
    // A late success after the deadline must not overwrite the timeout.
    resolveHandler?.({
      kind: "auth-status",
      connected: true,
      login: "late",
      detail: "CONNECTED",
    });
    await run;
    expect(
      events.some(
        (e) => e.type === "AUTH_RESOLVED" && e.attemptId === 1,
      ),
    ).toBe(false);
  });

  it("dispatches AUTH_FAILED with the handler's error code when it rejects", async () => {
    vi.useFakeTimers();
    const authStatus = vi.fn().mockRejectedValue(
      Object.assign(new Error("boom"), {
        code: "DM_GITHUB_TIMEOUT",
        name: "KestrelError",
      }),
    );
    const events: SessionEvent[] = [];
    const run = runStartupAuth({
      handlers: handlers({ authStatus }),
      parentSignal: new AbortController().signal,
      attemptId: 1,
      dispatch: (event) => events.push(event),
    });
    await vi.runAllTimersAsync();
    await run;
    expect(events).toContainEqual({
      type: "AUTH_FAILED",
      attemptId: 1,
      errorCode: "DM_GITHUB_TIMEOUT",
    });
  });

  it("dispatches AUTH_FAILED with UNKNOWN when the handler rejects without a code", async () => {
    vi.useFakeTimers();
    const authStatus = vi.fn().mockRejectedValue(new Error("boom"));
    const events: SessionEvent[] = [];
    const run = runStartupAuth({
      handlers: handlers({ authStatus }),
      parentSignal: new AbortController().signal,
      attemptId: 1,
      dispatch: (event) => events.push(event),
    });
    await vi.runAllTimersAsync();
    await run;
    expect(events).toContainEqual({
      type: "AUTH_FAILED",
      attemptId: 1,
      errorCode: "UNKNOWN",
    });
  });

  it("passes an abort signal to the authStatus handler", async () => {
    vi.useFakeTimers();
    const authStatus = vi.fn().mockResolvedValue({
      kind: "auth-status",
      connected: true,
      login: "octocat",
      detail: "CONNECTED",
    });
    const events: SessionEvent[] = [];
    const run = runStartupAuth({
      handlers: handlers({ authStatus }),
      parentSignal: new AbortController().signal,
      attemptId: 1,
      dispatch: (event) => events.push(event),
    });
    await vi.runAllTimersAsync();
    await run;
    const ctx = vi.mocked(authStatus).mock.calls[0]?.[1] as
      | CommandContext
      | undefined;
    expect(ctx?.signal).toBeDefined();
  });

  it("aborts the authStatus signal when the parent aborts and dispatches no failure event", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const authStatus = vi.fn(async (_args: unknown, ctx: CommandContext) => {
      capturedSignal = ctx.signal;
      return new Promise<ViewModel>((resolve) => {
        ctx.signal?.addEventListener("abort", () => {
          resolve({
            kind: "auth-status",
            connected: false,
            login: null,
            detail: "NOT_CONNECTED",
          });
        });
      });
    });
    const events: SessionEvent[] = [];
    const run = runStartupAuth({
      handlers: handlers({ authStatus }),
      parentSignal: parent.signal,
      attemptId: 1,
      dispatch: (event) => events.push(event),
    });
    parent.abort(new Error("lifetime"));
    await vi.runAllTimersAsync();
    await run;
    expect(capturedSignal?.aborted).toBe(true);
    // Parent abort must not surface as an AUTH_FAILED — the session is
    // unmounting and we don't want a spurious auth transition on shutdown.
    expect(events.some((e) => e.type === "AUTH_FAILED")).toBe(false);
  });
});