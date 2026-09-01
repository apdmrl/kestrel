import { describe, expect, it } from "vitest";
import type { RecommendationViewModel, ViewModel } from "../presentation/view-models.js";
import type { TranscriptEntry } from "./session-view-models.js";
import {
  initialSessionState,
  sessionReducer,
  type SessionAuthState,
  type SessionEvent,
  type SessionState,
} from "./session-state.js";

const recommendation: RecommendationViewModel = {
  kind: "recommendation",
  recommendationId: "rec-1",
  challengeId: "ch-1",
  title: "Refactor the auth gateway",
  mood: "QUICK_WIN",
  confidence: 0.9,
  reasons: ["matches your recent merges"],
};

function recommendationView(overrides: Partial<RecommendationViewModel> = {}): RecommendationViewModel {
  return { ...recommendation, ...overrides };
}

function entry(id: number): TranscriptEntry {
  return { id, kind: "output", text: `entry ${id}` };
}

describe("session reducer", () => {
  it.each([
    [{ type: "AUTH_RESOLVED", attemptId: 1, detail: "NOT_CONNECTED", login: null }, "required"],
    [{ type: "AUTH_RESOLVED", attemptId: 1, detail: "EXPIRED", login: null }, "expired"],
    [{ type: "AUTH_RESOLVED", attemptId: 1, detail: "CONNECTED", login: "octocat" }, "connected"],
    [{ type: "AUTH_FAILED", attemptId: 1, errorCode: "DM_NETWORK_UNAVAILABLE" }, "unknown"],
  ] as const satisfies ReadonlyArray<readonly [SessionEvent, SessionAuthState["status"]]>)(
    "reduces startup auth result %#",
    (event, expected) => {
      expect(sessionReducer(initialSessionState(), event).auth.status).toBe(expected);
    },
  );

  it("ignores a late result from an expired auth attempt", () => {
    const retrying = sessionReducer(initialSessionState(), { type: "AUTH_CHECK_STARTED", attemptId: 2 });
    const late = sessionReducer(retrying, {
      type: "AUTH_RESOLVED",
      attemptId: 1,
      detail: "CONNECTED",
      login: "stale",
    });
    expect(late).toBe(retrying);
  });

  it("keeps the latest auth check active while the previous attempt is still pending", () => {
    const first = sessionReducer(initialSessionState(), { type: "AUTH_CHECK_STARTED", attemptId: 1 });
    const second = sessionReducer(first, { type: "AUTH_CHECK_STARTED", attemptId: 2 });
    const firstLate = sessionReducer(second, {
      type: "AUTH_RESOLVED",
      attemptId: 1,
      detail: "CONNECTED",
      login: "stale",
    });
    expect(firstLate).toBe(second);
  });

  it("reduces AUTH_RESOLVED with the connected login exactly once", () => {
    const started = sessionReducer(initialSessionState(), { type: "AUTH_CHECK_STARTED", attemptId: 1 });
    const connected = sessionReducer(started, {
      type: "AUTH_RESOLVED",
      attemptId: 1,
      detail: "CONNECTED",
      login: "octocat",
    });
    expect(connected.auth).toEqual({ status: "connected", login: "octocat" });
  });

  it("transitions unknown → checking → connected", () => {
    const unknown = sessionReducer(initialSessionState(), {
      type: "AUTH_FAILED",
      attemptId: 1,
      errorCode: "STARTUP_AUTH_TIMEOUT",
    });
    const started = sessionReducer(unknown, { type: "AUTH_CHECK_STARTED", attemptId: 2 });
    const connected = sessionReducer(started, {
      type: "AUTH_RESOLVED",
      attemptId: 2,
      detail: "CONNECTED",
      login: "octocat",
    });
    expect(connected.auth).toEqual({ status: "connected", login: "octocat" });
  });

  it("begins a login and stores the device authorization view", () => {
    const started = sessionReducer(initialSessionState(), {
      type: "OPERATION_STARTED",
      operationId: 7,
      command: "/auth login",
      cancellable: true,
    });
    const notice = sessionReducer(started, {
      type: "LOGIN_AUTHORIZATION",
      operationId: 7,
      authorization: {
        verificationUri: "https://github.com/login/device",
        userCode: "ABCD-1234",
        expiresAt: 60_000,
      },
    });
    expect(notice.auth).toEqual({
      status: "logging-in",
      phase: "awaiting-user",
      authorization: {
        verificationUri: "https://github.com/login/device",
        userCode: "ABCD-1234",
        expiresAt: 60_000,
      },
    });
  });

  it("ignores a login authorization from a stale operation", () => {
    const started = sessionReducer(initialSessionState(), {
      type: "OPERATION_STARTED",
      operationId: 7,
      command: "/auth login",
      cancellable: true,
    });
    const superseded = sessionReducer(started, {
      type: "OPERATION_STARTED",
      operationId: 9,
      command: "/auth status",
      cancellable: true,
    });
    const stale = sessionReducer(superseded, {
      type: "LOGIN_AUTHORIZATION",
      operationId: 7,
      authorization: {
        verificationUri: "https://github.com/login/device",
        userCode: "ABCD-1234",
        expiresAt: 60_000,
      },
    });
    expect(stale).toBe(superseded);
  });

  it("captures the auth state before login and restores it on cancellation", () => {
    const required = sessionReducer(initialSessionState(), {
      type: "AUTH_RESOLVED",
      attemptId: 1,
      detail: "NOT_CONNECTED",
      login: null,
    });
    const started = sessionReducer(required, {
      type: "OPERATION_STARTED",
      operationId: 4,
      command: "/auth login",
      cancellable: true,
    });
    expect(started.operation).toMatchObject({ status: "running", operationId: 4 });
    expect(started.operation).toMatchObject({
      status: "running",
      authBeforeLogin: { status: "required" },
    });
    const cancelled = sessionReducer(started, { type: "OPERATION_CANCELLED", operationId: 4 });
    expect(cancelled.auth).toEqual({ status: "required" });
    expect(cancelled.operation).toEqual({ status: "idle" });
  });

  it("restores authBeforeLogin when a login operation fails", () => {
    const expired = sessionReducer(initialSessionState(), {
      type: "AUTH_RESOLVED",
      attemptId: 1,
      detail: "EXPIRED",
      login: null,
    });
    const started = sessionReducer(expired, {
      type: "OPERATION_STARTED",
      operationId: 4,
      command: "/auth login",
      cancellable: true,
    });
    const notice = sessionReducer(started, {
      type: "LOGIN_AUTHORIZATION",
      operationId: 4,
      authorization: {
        verificationUri: "https://github.com/login/device",
        userCode: "ABCD-1234",
        expiresAt: 60_000,
      },
    });
    const failed = sessionReducer(notice, {
      type: "OPERATION_FAILED",
      operationId: 4,
      errorCode: "DM_GITHUB_AUTH_CANCELLED",
    });
    expect(failed.auth).toEqual({ status: "expired" });
    expect(failed.operation).toEqual({ status: "idle" });
  });

  it("never stores a device code or token on auth", () => {
    const started = sessionReducer(initialSessionState(), {
      type: "OPERATION_STARTED",
      operationId: 4,
      command: "/auth login",
      cancellable: true,
    });
    const notice = sessionReducer(started, {
      type: "LOGIN_AUTHORIZATION",
      operationId: 4,
      authorization: {
        verificationUri: "https://github.com/login/device",
        userCode: "ABCD-1234",
        expiresAt: 60_000,
      },
    });
    const json = JSON.stringify(notice);
    expect(json).not.toContain("deviceCode");
    expect(json).not.toContain("device_code");
  });

  it("starts without a stored recommendation and serializes no recommendation data from the initial state", () => {
    const state: SessionState = initialSessionState();
    expect(state.latestRecommendation).toBeNull();
    const json = JSON.stringify(state);
    expect(json).not.toContain("recommendationId");
    expect(json).not.toContain("rec-1");
  });

  it("stores the matching operation's recommendation view exactly on success", () => {
    const started = sessionReducer(initialSessionState(), {
      type: "OPERATION_STARTED",
      operationId: 11,
      command: "/find",
      cancellable: true,
    });
    const succeeded = sessionReducer(started, {
      type: "OPERATION_SUCCEEDED",
      operationId: 11,
      view: recommendationView(),
    });
    expect(succeeded.latestRecommendation).toEqual(recommendationView());
    expect(succeeded.operation).toEqual({ status: "idle" });
  });

  it("clears latestRecommendation on a successful mission view", () => {
    const withRecommendation = sessionReducer(
      sessionReducer(initialSessionState(), {
        type: "OPERATION_STARTED",
        operationId: 1,
        command: "/find",
        cancellable: true,
      }),
      {
        type: "OPERATION_SUCCEEDED",
        operationId: 1,
        view: recommendationView(),
      },
    );
    expect(withRecommendation.latestRecommendation).not.toBeNull();
    const startedAccept = sessionReducer(withRecommendation, {
      type: "OPERATION_STARTED",
      operationId: 2,
      command: "/mission accept --id rec-1",
      cancellable: true,
    });
    const accepted = sessionReducer(startedAccept, {
      type: "OPERATION_SUCCEEDED",
      operationId: 2,
      view: { kind: "mission", id: "rec-1", status: "active", title: "Refactor the auth gateway" },
    });
    expect(accepted.latestRecommendation).toBeNull();
    expect(accepted.operation).toEqual({ status: "idle" });
  });

  it("rejects a stale successful completion from a previous operation", () => {
    const initial = initialSessionState();
    const stale = sessionReducer(initial, {
      type: "OPERATION_SUCCEEDED",
      operationId: 99,
      view: recommendationView({ recommendationId: "stale" }),
    });
    expect(stale).toBe(initial);
    expect(stale.latestRecommendation).toBeNull();
  });

  it("rejects a stale failed or cancelled completion from a previous operation", () => {
    const started = sessionReducer(initialSessionState(), {
      type: "OPERATION_STARTED",
      operationId: 1,
      command: "/find",
      cancellable: true,
    });
    const staleFailed = sessionReducer(started, {
      type: "OPERATION_FAILED",
      operationId: 99,
      errorCode: "DM_TRANSIENT_FAILURE",
    });
    expect(staleFailed).toBe(started);
    const staleCancelled = sessionReducer(started, {
      type: "OPERATION_CANCELLED",
      operationId: 99,
    });
    expect(staleCancelled).toBe(started);
  });

  it("stores the exact recommendation view rather than a projection", () => {
    const started = sessionReducer(initialSessionState(), {
      type: "OPERATION_STARTED",
      operationId: 1,
      command: "/find",
      cancellable: true,
    });
    const exact: RecommendationViewModel = recommendationView({
      recommendationId: "rec-42",
      challengeId: "ch-42",
      title: "Implement the runtime timer",
      mood: "DEEP_WORK",
      confidence: 0.42,
      reasons: ["uses your preferred stack", "tests your cancellation handling"],
    });
    const succeeded = sessionReducer(started, {
      type: "OPERATION_SUCCEEDED",
      operationId: 1,
      view: exact,
    });
    expect(succeeded.latestRecommendation).toBe(exact);
  });

  it("ignores a successful completion carrying an unrelated view kind", () => {
    const started = sessionReducer(initialSessionState(), {
      type: "OPERATION_STARTED",
      operationId: 1,
      command: "/find",
      cancellable: true,
    });
    const unrelated = sessionReducer(started, {
      type: "OPERATION_SUCCEEDED",
      operationId: 1,
      view: { kind: "progress", counts: { completed: 1 }, summary: "ok" } satisfies ViewModel,
    });
    expect(unrelated.latestRecommendation).toBeNull();
    expect(unrelated.operation).toEqual({ status: "idle" });
  });

  it("preserves auth across a successful local /progress operation", () => {
    const unknown = sessionReducer(initialSessionState(), {
      type: "AUTH_FAILED",
      attemptId: 1,
      errorCode: "DM_NETWORK_UNAVAILABLE",
    });
    const started = sessionReducer(unknown, {
      type: "OPERATION_STARTED",
      operationId: 1,
      command: "/progress",
      cancellable: true,
    });
    const succeeded = sessionReducer(started, {
      type: "OPERATION_SUCCEEDED",
      operationId: 1,
      view: { kind: "progress", counts: { completed: 0 }, summary: "no missions yet" },
    });
    expect(succeeded.auth).toEqual({ status: "unknown", errorCode: "DM_NETWORK_UNAVAILABLE" });
  });

  it("updates input text exactly on INPUT_CHANGED", () => {
    const typed = sessionReducer(initialSessionState(), { type: "INPUT_CHANGED", input: "/fin" });
    expect(typed.input).toBe("/fin");
    const cleared = sessionReducer(typed, { type: "INPUT_CHANGED", input: "" });
    expect(cleared.input).toBe("");
  });

  it("appends transcript entries and clears them", () => {
    const first = sessionReducer(initialSessionState(), {
      type: "TRANSCRIPT_APPENDED",
      entry: entry(1),
    });
    const second = sessionReducer(first, { type: "TRANSCRIPT_APPENDED", entry: entry(2) });
    expect(second.transcript).toEqual([entry(1), entry(2)]);
    const cleared = sessionReducer(second, { type: "TRANSCRIPT_CLEARED" });
    expect(cleared.transcript).toEqual([]);
  });

  it("bounds the transcript at the existing 200-entry limit", () => {
    let state = initialSessionState();
    for (let id = 1; id <= 250; id += 1) {
      state = sessionReducer(state, { type: "TRANSCRIPT_APPENDED", entry: entry(id) });
    }
    expect(state.transcript).toHaveLength(200);
    expect(state.transcript[0]?.id).toBe(51);
    expect(state.transcript[199]?.id).toBe(250);
  });

  it("records section and action selection", () => {
    const selected = sessionReducer(initialSessionState(), {
      type: "SECTION_SELECTED",
      sectionId: "find",
      index: 2,
    });
    expect(selected.activeSectionId).toBe("find");
    expect(selected.selectedSectionIndex).toBe(2);
    const actionSelected = sessionReducer(selected, {
      type: "ACTION_SELECTED",
      index: 3,
    });
    expect(actionSelected.selectedActionIndex).toBe(3);
  });

  it("moves focus across prompt, sidebar, and actions", () => {
    const prompt = sessionReducer(initialSessionState(), { type: "FOCUS_CHANGED", focus: "prompt" });
    expect(prompt.focus).toBe("prompt");
    const sidebar = sessionReducer(prompt, { type: "FOCUS_CHANGED", focus: "sidebar" });
    expect(sidebar.focus).toBe("sidebar");
    const actions = sessionReducer(sidebar, { type: "FOCUS_CHANGED", focus: "actions" });
    expect(actions.focus).toBe("actions");
  });

  it("clears latestRecommendation, operation, input, and section selection on HOME_SELECTED", () => {
    const seeded: SessionState = {
      ...initialSessionState(),
      latestRecommendation: recommendationView(),
      input: "/mission accept --id rec-1",
      selectedActionIndex: 4,
      focus: "actions",
    };
    const home = sessionReducer(seeded, { type: "HOME_SELECTED" });
    expect(home.latestRecommendation).toBeNull();
    expect(home.input).toBe("");
    expect(home.selectedActionIndex).toBe(0);
    expect(home.focus).toBe("prompt");
    expect(home.activeSectionId).toBe("home");
  });

  it("returns a fresh state object on HOME_SELECTED even when already on home", () => {
    const home = sessionReducer(initialSessionState(), { type: "HOME_SELECTED" });
    expect(home).not.toBe(initialSessionState());
    expect(home.activeSectionId).toBe("home");
  });

  it("ignores LOGIN_AUTHORIZATION when no matching operation is running", () => {
    const initial = initialSessionState();
    const idle = sessionReducer(initial, {
      type: "LOGIN_AUTHORIZATION",
      operationId: 4,
      authorization: {
        verificationUri: "https://github.com/login/device",
        userCode: "ABCD-1234",
        expiresAt: 60_000,
      },
    });
    expect(idle).toBe(initial);
  });

  it("does not store any token, device code, or credential inside session state", () => {
    const initial = initialSessionState();
    const started = sessionReducer(initial, {
      type: "OPERATION_STARTED",
      operationId: 4,
      command: "/auth login",
      cancellable: true,
    });
    const notice = sessionReducer(started, {
      type: "LOGIN_AUTHORIZATION",
      operationId: 4,
      authorization: {
        verificationUri: "https://github.com/login/device",
        userCode: "ABCD-1234",
        expiresAt: 60_000,
      },
    });
    const json = JSON.stringify(notice);
    expect(json).not.toContain("deviceCode");
    expect(json).not.toContain("device_code");
    expect(json).not.toMatch(/\btoken\b/u);
  });

  it("exposes a connected login identical to the AUTH_RESOLVED payload", () => {
    const checking = sessionReducer(initialSessionState(), { type: "AUTH_CHECK_STARTED", attemptId: 5 });
    const connected = sessionReducer(checking, {
      type: "AUTH_RESOLVED",
      attemptId: 5,
      detail: "CONNECTED",
      login: "octocat",
    });
    expect(connected.auth).toEqual({ status: "connected", login: "octocat" });
  });

  it("ignores AUTH_RESOLVED CONNECTED with a null login rather than misclassifying as expired", () => {
    const checking = sessionReducer(initialSessionState(), { type: "AUTH_CHECK_STARTED", attemptId: 1 });
    const inconsistent = {
      type: "AUTH_RESOLVED",
      attemptId: 1,
      detail: "CONNECTED",
      login: null,
    } as unknown as SessionEvent;
    const result = sessionReducer(checking, inconsistent);
    expect(result).toBe(checking);
  });

  it("ignores AUTH_RESOLVED NOT_CONNECTED with a non-null login", () => {
    const checking = sessionReducer(initialSessionState(), { type: "AUTH_CHECK_STARTED", attemptId: 1 });
    const inconsistent = {
      type: "AUTH_RESOLVED",
      attemptId: 1,
      detail: "NOT_CONNECTED",
      login: "stale",
    } as unknown as SessionEvent;
    const result = sessionReducer(checking, inconsistent);
    expect(result).toBe(checking);
  });

  it("ignores AUTH_RESOLVED EXPIRED with a non-null login", () => {
    const checking = sessionReducer(initialSessionState(), { type: "AUTH_CHECK_STARTED", attemptId: 1 });
    const inconsistent = {
      type: "AUTH_RESOLVED",
      attemptId: 1,
      detail: "EXPIRED",
      login: "stale",
    } as unknown as SessionEvent;
    const result = sessionReducer(checking, inconsistent);
    expect(result).toBe(checking);
  });

  it("promotes a login operation success with a connected auth-status view to connected", () => {
    const required = sessionReducer(initialSessionState(), {
      type: "AUTH_RESOLVED",
      attemptId: 1,
      detail: "NOT_CONNECTED",
      login: null,
    });
    const started = sessionReducer(required, {
      type: "OPERATION_STARTED",
      operationId: 4,
      command: "/auth login",
      cancellable: true,
    });
    const succeeded = sessionReducer(started, {
      type: "OPERATION_SUCCEEDED",
      operationId: 4,
      view: {
        kind: "auth-status",
        connected: true,
        login: "octocat",
        detail: "CONNECTED",
      },
    });
    expect(succeeded.auth).toEqual({ status: "connected", login: "octocat" });
    expect(succeeded.operation).toEqual({ status: "idle" });
  });

  it("restores authBeforeLogin when a login operation succeeds with a non-auth-status view", () => {
    const expired = sessionReducer(initialSessionState(), {
      type: "AUTH_RESOLVED",
      attemptId: 1,
      detail: "EXPIRED",
      login: null,
    });
    const started = sessionReducer(expired, {
      type: "OPERATION_STARTED",
      operationId: 4,
      command: "/auth login",
      cancellable: true,
    });
    const succeeded = sessionReducer(started, {
      type: "OPERATION_SUCCEEDED",
      operationId: 4,
      view: { kind: "progress", counts: { completed: 0 }, summary: "ok" },
    });
    expect(succeeded.auth).toEqual({ status: "expired" });
    expect(succeeded.operation).toEqual({ status: "idle" });
  });

  it("restores authBeforeLogin when a login operation succeeds with a not-connected auth-status view", () => {
    const expired = sessionReducer(initialSessionState(), {
      type: "AUTH_RESOLVED",
      attemptId: 1,
      detail: "EXPIRED",
      login: null,
    });
    const started = sessionReducer(expired, {
      type: "OPERATION_STARTED",
      operationId: 4,
      command: "/auth login",
      cancellable: true,
    });
    const succeeded = sessionReducer(started, {
      type: "OPERATION_SUCCEEDED",
      operationId: 4,
      view: {
        kind: "auth-status",
        connected: false,
        login: null,
        detail: "NOT_CONNECTED",
      },
    });
    expect(succeeded.auth).toEqual({ status: "expired" });
    expect(succeeded.operation).toEqual({ status: "idle" });
  });

  it("restores authBeforeLogin when a login operation succeeds with an auth-status view lacking a login", () => {
    const expired = sessionReducer(initialSessionState(), {
      type: "AUTH_RESOLVED",
      attemptId: 1,
      detail: "EXPIRED",
      login: null,
    });
    const started = sessionReducer(expired, {
      type: "OPERATION_STARTED",
      operationId: 4,
      command: "/auth login",
      cancellable: true,
    });
    const succeeded = sessionReducer(started, {
      type: "OPERATION_SUCCEEDED",
      operationId: 4,
      view: {
        kind: "auth-status",
        connected: true,
        login: null,
        detail: "CONNECTED",
      },
    });
    expect(succeeded.auth).toEqual({ status: "expired" });
    expect(succeeded.operation).toEqual({ status: "idle" });
  });

  it("restores authBeforeLogin when OPERATION_STARTED supersedes a running login with a non-login command", () => {
    const expired = sessionReducer(initialSessionState(), {
      type: "AUTH_RESOLVED",
      attemptId: 1,
      detail: "EXPIRED",
      login: null,
    });
    const loginStarted = sessionReducer(expired, {
      type: "OPERATION_STARTED",
      operationId: 4,
      command: "/auth login",
      cancellable: true,
    });
    expect(loginStarted.auth).toEqual({ status: "logging-in", phase: "starting" });
    const superseded = sessionReducer(loginStarted, {
      type: "OPERATION_STARTED",
      operationId: 5,
      command: "/find",
      cancellable: true,
    });
    expect(superseded.auth).toEqual({ status: "expired" });
    expect(superseded.operation).toMatchObject({ status: "running", operationId: 5 });
  });

  it("restores authBeforeLogin when OPERATION_STARTED supersedes a running login with another login", () => {
    const required = sessionReducer(initialSessionState(), {
      type: "AUTH_RESOLVED",
      attemptId: 1,
      detail: "NOT_CONNECTED",
      login: null,
    });
    const firstLogin = sessionReducer(required, {
      type: "OPERATION_STARTED",
      operationId: 4,
      command: "/auth login",
      cancellable: true,
    });
    const secondLogin = sessionReducer(firstLogin, {
      type: "OPERATION_STARTED",
      operationId: 5,
      command: "/auth login",
      cancellable: true,
    });
    expect(secondLogin.auth).toEqual({ status: "logging-in", phase: "starting" });
    expect(secondLogin.operation).toMatchObject({
      status: "running",
      operationId: 5,
      authBeforeLogin: { status: "required" },
    });
  });

  it("restores authBeforeLogin when HOME_SELECTED abandons a running login", () => {
    const expired = sessionReducer(initialSessionState(), {
      type: "AUTH_RESOLVED",
      attemptId: 1,
      detail: "EXPIRED",
      login: null,
    });
    const started = sessionReducer(expired, {
      type: "OPERATION_STARTED",
      operationId: 4,
      command: "/auth login",
      cancellable: true,
    });
    expect(started.auth).toEqual({ status: "logging-in", phase: "starting" });
    const home = sessionReducer(started, { type: "HOME_SELECTED" });
    expect(home.auth).toEqual({ status: "expired" });
    expect(home.operation).toEqual({ status: "idle" });
  });

  describe.each([
    [
      "checking",
      { type: "AUTH_CHECK_STARTED", attemptId: 1 } as const,
      { status: "checking", attemptId: 1 } satisfies SessionAuthState,
    ],
    [
      "connected",
      { type: "AUTH_RESOLVED", attemptId: 1, detail: "CONNECTED", login: "octocat" } as const,
      { status: "connected", login: "octocat" } satisfies SessionAuthState,
    ],
    [
      "required",
      { type: "AUTH_RESOLVED", attemptId: 1, detail: "NOT_CONNECTED", login: null } as const,
      { status: "required" } satisfies SessionAuthState,
    ],
    [
      "expired",
      { type: "AUTH_RESOLVED", attemptId: 1, detail: "EXPIRED", login: null } as const,
      { status: "expired" } satisfies SessionAuthState,
    ],
    [
      "unknown",
      { type: "AUTH_FAILED", attemptId: 1, errorCode: "DM_NETWORK_UNAVAILABLE" } as const,
      { status: "unknown", errorCode: "DM_NETWORK_UNAVAILABLE" } satisfies SessionAuthState,
    ],
  ])("login cancellation and failure restoration from %s", (_name, seeding, expected) => {
    it("restores authBeforeLogin on OPERATION_CANCELLED", () => {
      const seeded = sessionReducer(initialSessionState(), seeding);
      const started = sessionReducer(seeded, {
        type: "OPERATION_STARTED",
        operationId: 1,
        command: "/auth login",
        cancellable: true,
      });
      const cancelled = sessionReducer(started, { type: "OPERATION_CANCELLED", operationId: 1 });
      expect(cancelled.auth).toEqual(expected);
      expect(cancelled.operation).toEqual({ status: "idle" });
    });

    it("restores authBeforeLogin on OPERATION_FAILED", () => {
      const seeded = sessionReducer(initialSessionState(), seeding);
      const started = sessionReducer(seeded, {
        type: "OPERATION_STARTED",
        operationId: 1,
        command: "/auth login",
        cancellable: true,
      });
      const failed = sessionReducer(started, {
        type: "OPERATION_FAILED",
        operationId: 1,
        errorCode: "DM_GITHUB_AUTH_CANCELLED",
      });
      expect(failed.auth).toEqual(expected);
      expect(failed.operation).toEqual({ status: "idle" });
    });
  });
  });

describe("initialSessionState", () => {
  it("starts in the auth-checking phase on attempt 1 with no input or recommendation", () => {
    const state = initialSessionState();
    expect(state.auth).toEqual({ status: "checking", attemptId: 1 });
    expect(state.operation).toEqual({ status: "idle" });
    expect(state.latestRecommendation).toBeNull();
    expect(state.input).toBe("");
    expect(state.transcript).toEqual([]);
    expect(state.activeSectionId).toBe("home");
    expect(state.focus).toBe("prompt");
    expect(state.selectedSectionIndex).toBe(0);
    expect(state.selectedActionIndex).toBe(0);
  });
});