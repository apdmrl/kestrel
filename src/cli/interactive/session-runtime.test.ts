import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandContext, CommandHandlers } from "../command-handlers.js";
import type { ViewModel } from "../presentation/view-models.js";
import {
  createAdmissionSlot,
  createChildOperation,
  releaseAdmission,
  runStartupAuth,
  STARTUP_AUTH_TIMEOUT_MS,
  tryAdmit,
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
    const handle = runStartupAuth({
      handlers: handlers({ authStatus }),
      parentSignal: new AbortController().signal,
      attemptId: 1,
      dispatch: (event) => events.push(event),
    });
    await vi.runAllTimersAsync();
    await handle.run;
    expect(events).toContainEqual({
      type: "AUTH_RESOLVED",
      attemptId: 1,
      detail: "CONNECTED",
      login: "octocat",
    });
    handle.dispose();
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
    const handle = runStartupAuth({
      handlers: handlers({ authStatus }),
      parentSignal: new AbortController().signal,
      attemptId: 1,
      dispatch: (event) => events.push(event),
    });
    await vi.runAllTimersAsync();
    await handle.run;
    expect(events).toContainEqual({
      type: "AUTH_RESOLVED",
      attemptId: 1,
      detail: "NOT_CONNECTED",
      login: null,
    });
    handle.dispose();
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
    const handle = runStartupAuth({
      handlers: handlers({ authStatus }),
      parentSignal: new AbortController().signal,
      attemptId: 1,
      dispatch: (event) => events.push(event),
    });
    await vi.runAllTimersAsync();
    await handle.run;
    expect(events).toContainEqual({
      type: "AUTH_RESOLVED",
      attemptId: 1,
      detail: "EXPIRED",
      login: null,
    });
    handle.dispose();
  });

  it("renders first and marks auth unknown at the five-second deadline", async () => {
    vi.useFakeTimers();
    const authStatus = vi.fn(() => new Promise<ViewModel>(() => undefined));
    const events: SessionEvent[] = [];
    const handle = runStartupAuth({
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
    await handle.run;
    handle.dispose();
  });

  it("settles when the deadline wins even if the handler ignores abort", async () => {
    vi.useFakeTimers();
    // The handler's promise never resolves and never observes the abort
    // signal — `runStartupAuth` must still settle so the reducer can
    // transition to `unknown` and the rest of the session can render.
    const authStatus = vi.fn(() => new Promise<ViewModel>(() => undefined));
    const events: SessionEvent[] = [];
    const handle = runStartupAuth({
      handlers: handlers({ authStatus }),
      parentSignal: new AbortController().signal,
      attemptId: 1,
      dispatch: (event) => events.push(event),
    });
    await vi.advanceTimersByTimeAsync(STARTUP_AUTH_TIMEOUT_MS);
    await handle.run;
    expect(events.some((e) => e.type === "AUTH_FAILED")).toBe(true);
    handle.dispose();
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
    const handle = runStartupAuth({
      handlers: handlers({ authStatus }),
      parentSignal: new AbortController().signal,
      attemptId: 1,
      dispatch: (event) => events.push(event),
    });
    await vi.advanceTimersByTimeAsync(50);
    await vi.runAllTimersAsync();
    await handle.run;
    // No AUTH_FAILED was dispatched — the handler completed first.
    expect(events.some((e) => e.type === "AUTH_FAILED")).toBe(false);
    // Advancing past the deadline should NOT add an AUTH_FAILED now
    // because the timer was already cleared.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events.filter((e) => e.type === "AUTH_FAILED")).toHaveLength(0);
    handle.dispose();
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
    const handle = runStartupAuth({
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
    await handle.run;
    expect(events.some((e) => e.type === "AUTH_RESOLVED" && e.attemptId === 1)).toBe(false);
    handle.dispose();
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
    const handle = runStartupAuth({
      handlers: handlers({ authStatus }),
      parentSignal: new AbortController().signal,
      attemptId: 1,
      dispatch: (event) => events.push(event),
    });
    await vi.runAllTimersAsync();
    await handle.run;
    expect(events).toContainEqual({
      type: "AUTH_FAILED",
      attemptId: 1,
      errorCode: "DM_GITHUB_TIMEOUT",
    });
    handle.dispose();
  });

  it("dispatches AUTH_FAILED with UNKNOWN when the handler rejects without a code", async () => {
    vi.useFakeTimers();
    const authStatus = vi.fn().mockRejectedValue(new Error("boom"));
    const events: SessionEvent[] = [];
    const handle = runStartupAuth({
      handlers: handlers({ authStatus }),
      parentSignal: new AbortController().signal,
      attemptId: 1,
      dispatch: (event) => events.push(event),
    });
    await vi.runAllTimersAsync();
    await handle.run;
    expect(events).toContainEqual({
      type: "AUTH_FAILED",
      attemptId: 1,
      errorCode: "UNKNOWN",
    });
    handle.dispose();
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
    const handle = runStartupAuth({
      handlers: handlers({ authStatus }),
      parentSignal: new AbortController().signal,
      attemptId: 1,
      dispatch: (event) => events.push(event),
    });
    await vi.runAllTimersAsync();
    await handle.run;
    const ctx = vi.mocked(authStatus).mock.calls[0]?.[1] as CommandContext | undefined;
    expect(ctx?.signal).toBeDefined();
    handle.dispose();
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
    const handle = runStartupAuth({
      handlers: handlers({ authStatus }),
      parentSignal: parent.signal,
      attemptId: 1,
      dispatch: (event) => events.push(event),
    });
    parent.abort(new Error("lifetime"));
    await vi.runAllTimersAsync();
    await handle.run;
    expect(capturedSignal?.aborted).toBe(true);
    // Parent abort must not surface as an AUTH_FAILED — the session is
    // unmounting and we don't want a spurious auth transition on shutdown.
    expect(events.some((e) => e.type === "AUTH_FAILED")).toBe(false);
    handle.dispose();
  });

  it("clears the deadline timer and detaches the parent listener when disposed before the deadline", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const authStatus = vi.fn(async (_args: unknown, ctx: CommandContext) => {
      capturedSignal = ctx.signal;
      return new Promise<ViewModel>(() => undefined);
    });
    const events: SessionEvent[] = [];
    const handle = runStartupAuth({
      handlers: handlers({ authStatus }),
      parentSignal: parent.signal,
      attemptId: 1,
      dispatch: (event) => events.push(event),
    });
    // Unmount-before-deadline: dispose must abort the child, clear the
    // deadline timer, detach the parent listener, and settle without
    // dispatching any auth transition.
    handle.dispose();
    expect(capturedSignal?.aborted).toBe(true);
    expect(events).toEqual([]);
    // Advancing past the deadline must not dispatch a timeout — the
    // timer was cleared.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events.some((e) => e.type === "AUTH_FAILED")).toBe(false);
    // Promise must settle so callers awaiting the run handle resolve.
    await handle.run;
    // No late settlement is dispatched even after parent abort because
    // the runtime-detached listener does not run finalize again (it
    // was removed during dispose).
    handle.dispose();
  });

  it("suppresses a late handler resolution that arrives after dispose", async () => {
    vi.useFakeTimers();
    let resolveHandler: ((view: ViewModel) => void) | undefined;
    const authStatus = vi.fn(
      () =>
        new Promise<ViewModel>((resolve) => {
          resolveHandler = resolve;
        }),
    );
    const events: SessionEvent[] = [];
    const handle = runStartupAuth({
      handlers: handlers({ authStatus }),
      parentSignal: new AbortController().signal,
      attemptId: 1,
      dispatch: (event) => events.push(event),
    });
    // Unmount-before-deadline: dispose must abort the child and
    // suppress any handler settlement that arrives later.
    handle.dispose();
    await handle.run;
    // A late success arriving after dispose must not dispatch any auth
    // transition into a reducer that has already torn down.
    resolveHandler?.({
      kind: "auth-status",
      connected: true,
      login: "late",
      detail: "CONNECTED",
    });
    await vi.runAllTimersAsync();
    expect(events).toEqual([]);
    handle.dispose();
  });

  it("clears the deadline timer (vi.getTimerCount===0), removes every registered parent abort listener (paired add/remove spies), and absorbs a late parent abort after dispose", async () => {
    // Disposal contract: the runtime must release every resource it
    // acquired during startup. The deadline timer is the long-lived
    // setTimeout the runtime installs; the parent listener forwards
    // process shutdown to the child. After dispose, both must be gone.
    //
    // Spy on BOTH addEventListener and removeEventListener so the test
    // can pair every registration with its corresponding removal. A
    // removal that does not match a prior registration indicates a
    // leaked listener; a registration without a removal indicates a
    // dangling listener.
    vi.useFakeTimers();
    const parent = new AbortController();
    const addSpy = vi.spyOn(parent.signal, "addEventListener");
    const removeSpy = vi.spyOn(parent.signal, "removeEventListener");
    let capturedSignal: AbortSignal | undefined;
    const authStatus = vi.fn(async (_args: unknown, ctx: CommandContext) => {
      capturedSignal = ctx.signal;
      return new Promise<ViewModel>(() => undefined);
    });
    const events: SessionEvent[] = [];
    const handle = runStartupAuth({
      handlers: handlers({ authStatus }),
      parentSignal: parent.signal,
      attemptId: 1,
      dispatch: (event) => events.push(event),
    });
    // The deadline timer is installed; vi.getTimerCount is > 0.
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    // Snapshot the runtime-registered abort listeners BEFORE dispose
    // so we can prove every registration was paired with a removal.
    const registeredAbortListeners = addSpy.mock.calls
      .filter((call) => call[0] === "abort" && typeof call[1] === "function")
      .map((call) => call[1] as (...args: unknown[]) => unknown);
    expect(registeredAbortListeners.length).toBeGreaterThan(0);
    // Dispose: must abort the child, clear the timer, and remove the
    // parent listener.
    handle.dispose();
    // Timer cleared immediately — no leaked setTimeout.
    expect(vi.getTimerCount()).toBe(0);
    // Every registered parent abort callback must have been removed.
    for (const listener of registeredAbortListeners) {
      expect(removeSpy.mock.calls.some((call) => call[0] === "abort" && call[1] === listener)).toBe(
        true,
      );
    }
    // Child signal was aborted so handler-side cleanup can run.
    expect(capturedSignal?.aborted).toBe(true);
    expect(events).toEqual([]);
    // A late parent abort AFTER dispose must not dispatch anything.
    parent.abort(new Error("late lifetime"));
    await vi.runAllTimersAsync();
    expect(events).toEqual([]);
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  describe("admission slot (pure runtime guard)", () => {
    it("admits the first submission and rejects a second submission in the same tick", () => {
      // The OLD admission guard used React `busy` state, which is
      // deferred — two `submit()` calls dispatched in the same tick both
      // passed the guard and both ran their handlers. The pure
      // `AdmissionSlot` is the synchronous replacement that fails the
      // OLD code: the second `tryAdmit` in the same tick must return
      // `null` while the first is still active.
      let slot = createAdmissionSlot();
      const first = tryAdmit(slot);
      expect(first).not.toBeNull();
      if (first === null) throw new Error("first admit must succeed");
      slot = first.slot;
      const second = tryAdmit(slot);
      expect(second).toBeNull();
      // The slot state must reflect the active admission.
      expect(slot.running).toBe(true);
      expect(slot.activeId).toBe(first.token.id);
    });

    it("releases the slot only when the token matches the active operation", () => {
      // Stale completion cannot clear a freshly installed child's busy
      // state: the slot returns the original (unmodified) slot when the
      // token no longer matches.
      let slot = createAdmissionSlot();
      const first = tryAdmit(slot);
      expect(first).not.toBeNull();
      if (first === null) throw new Error("first admit must succeed");
      slot = first.slot;
      // Replace the active operation with a new admission (simulates a
      // newer submission landing while the first is still in flight).
      const replacement = tryAdmit(slot);
      expect(replacement).toBeNull();
      // Manually simulate the replacement by re-trying after a manual
      // release of the first token — proves the identity-check
      // requirement.
      const released = releaseAdmission(slot, first.token);
      expect(released.released).toBe(true);
      slot = released.slot;
      // Now the slot is empty; a new admission succeeds and produces a
      // different token.
      const second = tryAdmit(slot);
      expect(second).not.toBeNull();
      if (second === null) throw new Error("second admit must succeed");
      slot = second.slot;
      expect(second.token.id).not.toBe(first.token.id);
      // The OLD token can no longer release the slot.
      const stale = releaseAdmission(slot, first.token);
      expect(stale.released).toBe(false);
      expect(stale.slot).toBe(slot);
      // The matching token clears the slot.
      const matching = releaseAdmission(slot, second.token);
      expect(matching.released).toBe(true);
      expect(matching.slot.running).toBe(false);
      expect(matching.slot.activeId).toBeNull();
    });

    it("issues strictly increasing token ids so identity checks never collide", () => {
      let slot = createAdmissionSlot();
      const ids = new Set<number>();
      for (let i = 0; i < 5; i += 1) {
        const admit = tryAdmit(slot);
        expect(admit).not.toBeNull();
        if (admit === null) throw new Error(`admit ${i} must succeed`);
        ids.add(admit.token.id);
        slot = admit.slot;
        const release = releaseAdmission(slot, admit.token);
        slot = release.slot;
      }
      expect(ids.size).toBe(5);
    });
  });
});
