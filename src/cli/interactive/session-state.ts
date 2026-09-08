import type {
  MissionViewModel,
  RecommendationViewModel,
  ViewModel,
} from "../presentation/view-models.js";
import type { TranscriptEntry } from "./session-view-models.js";

export const MAX_TRANSCRIPT_ENTRIES = 200;
export const INITIAL_ATTEMPT_ID = 1;
export const INITIAL_AUTH_SECTION_ID = "home";

export type SessionAuthState =
  | { readonly status: "checking"; readonly attemptId: number }
  | { readonly status: "connected"; readonly login: string }
  | { readonly status: "required" }
  | { readonly status: "expired" }
  | { readonly status: "unknown"; readonly errorCode: string }
  | {
      readonly status: "logging-in";
      readonly phase: "starting" | "awaiting-user";
      readonly authorization?: {
        readonly verificationUri: string;
        readonly userCode: string;
        readonly expiresAt: number;
      };
    };

export type AuthResultDetail = "CONNECTED" | "NOT_CONNECTED" | "EXPIRED";

export type OperationState =
  | { readonly status: "idle" }
  | {
      readonly status: "running";
      readonly operationId: number;
      readonly command: string;
      readonly cancellable: boolean;
      readonly authBeforeLogin?: SessionAuthState;
    };

export type FocusArea = "prompt" | "sidebar" | "actions";

export interface SessionState {
  readonly auth: SessionAuthState;
  readonly operation: OperationState;
  readonly latestRecommendation: RecommendationViewModel | null;
  readonly currentMission: MissionViewModel | null;
  readonly currentMissionLoaded: boolean;
  readonly input: string;
  readonly transcript: readonly TranscriptEntry[];
  readonly activeSectionId: string;
  readonly focus: FocusArea;
  readonly selectedSectionIndex: number;
  readonly selectedActionIndex: number;
}

export type SessionEvent =
  | { readonly type: "AUTH_CHECK_STARTED"; readonly attemptId: number }
  | {
      readonly type: "AUTH_RESOLVED";
      readonly attemptId: number;
      readonly detail: "CONNECTED";
      readonly login: string;
    }
  | {
      readonly type: "AUTH_RESOLVED";
      readonly attemptId: number;
      readonly detail: "NOT_CONNECTED";
      readonly login: null;
    }
  | {
      readonly type: "AUTH_RESOLVED";
      readonly attemptId: number;
      readonly detail: "EXPIRED";
      readonly login: null;
    }
  | { readonly type: "AUTH_FAILED"; readonly attemptId: number; readonly errorCode: string }
  | {
      readonly type: "OPERATION_STARTED";
      readonly operationId: number;
      readonly command: string;
      readonly cancellable: boolean;
    }
  | {
      readonly type: "LOGIN_AUTHORIZATION";
      readonly operationId: number;
      readonly authorization: {
        readonly verificationUri: string;
        readonly userCode: string;
        readonly expiresAt: number;
      };
    }
  | {
      readonly type: "OPERATION_SUCCEEDED";
      readonly operationId: number;
      readonly view: ViewModel;
    }
  | {
      readonly type: "CURRENT_MISSION_RESOLVED";
      readonly mission: MissionViewModel | null;
    }
  | { readonly type: "FIND_COMPLETED_EMPTY"; readonly operationId: number }
  | { readonly type: "OPERATION_FAILED"; readonly operationId: number; readonly errorCode: string }
  | { readonly type: "OPERATION_CANCELLED"; readonly operationId: number }
  | { readonly type: "INPUT_CHANGED"; readonly input: string }
  | { readonly type: "TRANSCRIPT_APPENDED"; readonly entry: TranscriptEntry }
  | { readonly type: "TRANSCRIPT_CLEARED" }
  | { readonly type: "SECTION_SELECTED"; readonly sectionId: string; readonly index: number }
  | { readonly type: "ACTION_SELECTED"; readonly index: number }
  | { readonly type: "FOCUS_CHANGED"; readonly focus: FocusArea }
  | { readonly type: "HOME_SELECTED" };

export function isLoginCommand(command: string): boolean {
  const trimmed = command.trim();
  return trimmed === "/auth login" || trimmed.startsWith("/auth login ");
}

function isCurrentMissionCommand(command: string): boolean {
  const normalized = command.trim().split(/\s+/u).join(" ");
  return normalized === "/current" || normalized === "/mission current";
}
export function initialSessionState(
  initialNavigation: { readonly sectionId: string; readonly index: number } = {
    sectionId: INITIAL_AUTH_SECTION_ID,
    index: 0,
  },
): SessionState {
  return {
    auth: { status: "checking", attemptId: INITIAL_ATTEMPT_ID },
    operation: { status: "idle" },
    latestRecommendation: null,
    currentMission: null,
    currentMissionLoaded: false,
    input: "",
    transcript: [],
    activeSectionId: initialNavigation.sectionId,
    focus: "prompt",
    selectedSectionIndex: initialNavigation.index,
    selectedActionIndex: 0,
  };
}

export function sessionReducer(state: SessionState, event: SessionEvent): SessionState {
  switch (event.type) {
    case "AUTH_CHECK_STARTED": {
      if (state.auth.status === "checking" && state.auth.attemptId === event.attemptId) {
        return state;
      }
      return { ...state, auth: { status: "checking", attemptId: event.attemptId } };
    }
    case "AUTH_RESOLVED": {
      if (state.auth.status !== "checking" || state.auth.attemptId !== event.attemptId) {
        return state;
      }
      if (event.detail === "CONNECTED" && typeof event.login === "string") {
        return { ...state, auth: { status: "connected", login: event.login } };
      }
      if (event.detail === "NOT_CONNECTED" && event.login === null) {
        return { ...state, auth: { status: "required" } };
      }
      if (event.detail === "EXPIRED" && event.login === null) {
        return { ...state, auth: { status: "expired" } };
      }
      return state;
    }
    case "AUTH_FAILED": {
      if (state.auth.status !== "checking" || state.auth.attemptId !== event.attemptId) {
        return state;
      }
      return { ...state, auth: { status: "unknown", errorCode: event.errorCode } };
    }
    case "OPERATION_STARTED": {
      if (
        state.operation.status === "running" &&
        state.operation.operationId === event.operationId
      ) {
        return state;
      }
      const supersededAuth =
        state.operation.status === "running" && isLoginCommand(state.operation.command)
          ? (state.operation.authBeforeLogin ?? { status: "required" })
          : state.auth;
      if (!isLoginCommand(event.command)) {
        return {
          ...state,
          auth: supersededAuth,
          operation: {
            status: "running",
            operationId: event.operationId,
            command: event.command,
            cancellable: event.cancellable,
          },
        };
      }
      return {
        ...state,
        auth: { status: "logging-in", phase: "starting" },
        operation: {
          status: "running",
          operationId: event.operationId,
          command: event.command,
          cancellable: event.cancellable,
          authBeforeLogin: supersededAuth,
        },
      };
    }
    case "LOGIN_AUTHORIZATION": {
      const running = state.operation;
      if (running.status !== "running" || running.operationId !== event.operationId) return state;
      if (!isLoginCommand(running.command)) return state;
      return {
        ...state,
        auth: {
          status: "logging-in",
          phase: "awaiting-user",
          authorization: event.authorization,
        },
      };
    }
    case "FIND_COMPLETED_EMPTY": {
      const running = state.operation;
      if (running.status !== "running" || running.operationId !== event.operationId) return state;
      return { ...state, operation: { status: "idle" }, latestRecommendation: null };
    }
    case "CURRENT_MISSION_RESOLVED": {
      if (state.currentMissionLoaded) return state;
      return {
        ...state,
        currentMission: event.mission,
        currentMissionLoaded: true,
      };
    }
    case "OPERATION_SUCCEEDED": {
      const running = state.operation;
      if (running.status !== "running" || running.operationId !== event.operationId) return state;
      if (isLoginCommand(running.command)) {
        const view = event.view;
        if (view.kind === "auth-status" && view.connected && view.login !== null) {
          return {
            ...state,
            operation: { status: "idle" },
            auth: { status: "connected", login: view.login },
          };
        }
        return {
          ...state,
          operation: { status: "idle" },
          auth: running.authBeforeLogin ?? { status: "required" },
        };
      }
      if (event.view.kind === "auth-status") {
        const auth: SessionAuthState =
          event.view.connected && event.view.login !== null
            ? { status: "connected", login: event.view.login }
            : event.view.detail === "EXPIRED"
              ? { status: "expired" }
              : { status: "required" };
        return { ...state, operation: { status: "idle" }, auth };
      }
      if (event.view.kind === "verification" && isCurrentMissionCommand(running.command)) {
        return {
          ...state,
          operation: { status: "idle" },
          currentMission: null,
          currentMissionLoaded: true,
        };
      }
      if (event.view.kind === "recommendation") {
        return { ...state, operation: { status: "idle" }, latestRecommendation: event.view };
      }
      if (event.view.kind === "mission") {
        const currentMission =
          event.view.status === "COMPLETED" || event.view.status === "ABANDONED"
            ? null
            : event.view;
        return {
          ...state,
          operation: { status: "idle" },
          latestRecommendation: null,
          currentMission,
          currentMissionLoaded: true,
        };
      }
      return { ...state, operation: { status: "idle" } };
    }
    case "OPERATION_FAILED":
    case "OPERATION_CANCELLED": {
      const running = state.operation;
      if (running.status !== "running" || running.operationId !== event.operationId) return state;
      if (isLoginCommand(running.command)) {
        return {
          ...state,
          operation: { status: "idle" },
          auth: running.authBeforeLogin ?? { status: "required" },
        };
      }
      // Credential-validation failures invalidate any cached
      // connected state so the affected GitHub action stops being
      // advertised as enabled. Post-validation network/timeout/
      // provider errors leave the auth state untouched.
      if (event.type === "OPERATION_FAILED") {
        if (event.errorCode === "DM_GITHUB_AUTH_REQUIRED") {
          return { ...state, operation: { status: "idle" }, auth: { status: "required" } };
        }
        if (event.errorCode === "DM_GITHUB_AUTH_EXPIRED") {
          return { ...state, operation: { status: "idle" }, auth: { status: "expired" } };
        }
      }
      return { ...state, operation: { status: "idle" } };
    }
    case "INPUT_CHANGED": {
      if (state.input === event.input) return state;
      return { ...state, input: event.input };
    }
    case "TRANSCRIPT_APPENDED": {
      const next = [...state.transcript, event.entry];
      return {
        ...state,
        transcript:
          next.length > MAX_TRANSCRIPT_ENTRIES ? next.slice(-MAX_TRANSCRIPT_ENTRIES) : next,
      };
    }
    case "TRANSCRIPT_CLEARED": {
      if (state.transcript.length === 0) return state;
      return { ...state, transcript: [] };
    }
    case "SECTION_SELECTED": {
      if (state.activeSectionId === event.sectionId && state.selectedSectionIndex === event.index) {
        return state;
      }
      return {
        ...state,
        activeSectionId: event.sectionId,
        selectedSectionIndex: event.index,
        selectedActionIndex: 0,
      };
    }
    case "ACTION_SELECTED": {
      if (state.selectedActionIndex === event.index) return state;
      return { ...state, selectedActionIndex: event.index };
    }
    case "FOCUS_CHANGED": {
      if (state.focus === event.focus) return state;
      return { ...state, focus: event.focus };
    }
    case "HOME_SELECTED": {
      // Home must not release or reset a live operation, because its late
      // completion still needs the matching operation id. Navigation itself
      // remains safe to reset: it is presentation state and does not affect
      // admission, cancellation, auth recovery, or the pending result.
      if (state.operation.status === "running") {
        return {
          ...state,
          selectedActionIndex: 0,
          selectedSectionIndex: 0,
          focus: "prompt",
          activeSectionId: INITIAL_AUTH_SECTION_ID,
        };
      }
      return {
        ...state,
        auth: state.auth,
        operation: { status: "idle" },
        latestRecommendation: null,
        input: "",
        selectedActionIndex: 0,
        selectedSectionIndex: 0,
        focus: "prompt",
        activeSectionId: INITIAL_AUTH_SECTION_ID,
      };
    }
  }
}
