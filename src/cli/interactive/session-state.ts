import type { RecommendationViewModel, ViewModel } from "../presentation/view-models.js";
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
      readonly detail: AuthResultDetail;
      readonly login: string | null;
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
  | { readonly type: "OPERATION_FAILED"; readonly operationId: number; readonly errorCode: string }
  | { readonly type: "OPERATION_CANCELLED"; readonly operationId: number }
  | { readonly type: "INPUT_CHANGED"; readonly input: string }
  | { readonly type: "TRANSCRIPT_APPENDED"; readonly entry: TranscriptEntry }
  | { readonly type: "TRANSCRIPT_CLEARED" }
  | { readonly type: "SECTION_SELECTED"; readonly sectionId: string; readonly index: number }
  | { readonly type: "ACTION_SELECTED"; readonly index: number }
  | { readonly type: "FOCUS_CHANGED"; readonly focus: FocusArea }
  | { readonly type: "HOME_SELECTED" };

function isLoginCommand(command: string): boolean {
  const trimmed = command.trim();
  return trimmed === "/auth login" || trimmed.startsWith("/auth login ");
}

export function initialSessionState(): SessionState {
  return {
    auth: { status: "checking", attemptId: INITIAL_ATTEMPT_ID },
    operation: { status: "idle" },
    latestRecommendation: null,
    input: "",
    transcript: [],
    activeSectionId: INITIAL_AUTH_SECTION_ID,
    focus: "prompt",
    selectedSectionIndex: 0,
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
      if (event.detail === "CONNECTED" && event.login !== null) {
        return { ...state, auth: { status: "connected", login: event.login } };
      }
      if (event.detail === "NOT_CONNECTED") {
        return { ...state, auth: { status: "required" } };
      }
      return { ...state, auth: { status: "expired" } };
    }
    case "AUTH_FAILED": {
      if (state.auth.status !== "checking" || state.auth.attemptId !== event.attemptId) {
        return state;
      }
      return { ...state, auth: { status: "unknown", errorCode: event.errorCode } };
    }
    case "OPERATION_STARTED": {
      if (state.operation.status === "running" && state.operation.operationId === event.operationId) {
        return state;
      }
      if (!isLoginCommand(event.command)) {
        return {
          ...state,
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
        operation: {
          status: "running",
          operationId: event.operationId,
          command: event.command,
          cancellable: event.cancellable,
          authBeforeLogin: state.auth,
        },
        auth: { status: "logging-in", phase: "starting" },
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
    case "OPERATION_SUCCEEDED": {
      const running = state.operation;
      if (running.status !== "running" || running.operationId !== event.operationId) return state;
      if (isLoginCommand(running.command)) {
        const login = event.view.kind === "auth-status" && event.view.login !== null ? event.view.login : "unknown";
        return { ...state, operation: { status: "idle" }, auth: { status: "connected", login } };
      }
      if (event.view.kind === "recommendation") {
        return { ...state, operation: { status: "idle" }, latestRecommendation: event.view };
      }
      if (event.view.kind === "mission") {
        return { ...state, operation: { status: "idle" }, latestRecommendation: null };
      }
      return { ...state, operation: { status: "idle" } };
    }
    case "OPERATION_FAILED":
    case "OPERATION_CANCELLED": {
      const running = state.operation;
      if (running.status !== "running" || running.operationId !== event.operationId) return state;
      if (!isLoginCommand(running.command)) {
        return { ...state, operation: { status: "idle" } };
      }
      return {
        ...state,
        operation: { status: "idle" },
        auth: running.authBeforeLogin ?? { status: "required" },
      };
    }
    case "INPUT_CHANGED": {
      if (state.input === event.input) return state;
      return { ...state, input: event.input };
    }
    case "TRANSCRIPT_APPENDED": {
      const next = [...state.transcript, event.entry];
      return {
        ...state,
        transcript: next.length > MAX_TRANSCRIPT_ENTRIES ? next.slice(-MAX_TRANSCRIPT_ENTRIES) : next,
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
      return {
        ...state,
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