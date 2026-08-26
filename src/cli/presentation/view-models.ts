import type { ProgressCounts } from "../../application/journey/journey-projector.js";
import { isKestrelError } from "../../application/errors/kestrel-error.js";

export interface RecommendationViewModel {
  readonly kind: "recommendation";
  readonly recommendationId: string;
  readonly challengeId: string;
  readonly title: string;
  readonly mood: string;
  readonly confidence: number;
  readonly reasons: readonly string[];
}

export interface MissionViewModel {
  readonly kind: "mission";
  readonly id: string;
  readonly status: string;
  readonly title: string;
  readonly verification?: string;
  readonly repository?: string;
  readonly branch?: string;
}

export interface ProgressViewModel {
  readonly kind: "progress";
  readonly counts: ProgressCounts;
}

export interface JourneyEntryViewModel {
  readonly type: string;
  readonly missionId: string;
  readonly occurredAt: string;
}

export interface JourneyViewModel {
  readonly kind: "journey";
  readonly entries: readonly JourneyEntryViewModel[];
}

export interface PreferencesViewModel {
  readonly kind: "preferences";
  readonly version: number;
  readonly preferredLanguages: readonly string[];
  readonly preferredDifficulty: string | null;
  readonly defaultMode: string;
  readonly workspaceRoot: string | null;
}

export interface HandoffViewModel {
  readonly kind: "handoff";
  readonly handoffId: string;
  readonly renderedPromptHash: string;
}

export interface VerificationViewModel {
  readonly kind: "verification";
  readonly text: string;
}

/**
 * Device-flow instructions for the user.
 *
 * Carries only what is safe to display: the verification URI and the short user
 * code. The device code and the access token never reach presentation.
 *
 * Whether a browser opened is reported separately, as its own notice, so the
 * instructions are never printed twice.
 */
export interface DeviceAuthorizationViewModel {
  readonly kind: "device-authorization";
  readonly verificationUri: string;
  readonly userCode: string;
}

/**
 * GitHub connection state, shared by auth login, status, and logout so there is
 * exactly one machine-readable shape for authentication state.
 */
export interface AuthStatusViewModel {
  readonly kind: "auth-status";
  readonly connected: boolean;
  readonly login: string | null;
  readonly detail: "CONNECTED" | "NOT_CONNECTED" | "EXPIRED" | "LOGGED_OUT";
}

export interface ErrorViewModel {
  readonly kind: "error";
  readonly code: string;
  readonly userMessage: string;
  readonly suggestedActions: readonly string[];
}

export type ViewModel =
  | RecommendationViewModel
  | MissionViewModel
  | ProgressViewModel
  | JourneyViewModel
  | PreferencesViewModel
  | HandoffViewModel
  | VerificationViewModel
  | DeviceAuthorizationViewModel
  | AuthStatusViewModel
  | ErrorViewModel;

export function errorViewModel(error: unknown): ErrorViewModel {
  if (isKestrelError(error)) {
    return {
      kind: "error",
      code: error.code,
      userMessage: error.userMessage,
      suggestedActions: error.suggestedActions,
    };
  }
  return {
    kind: "error",
    code: "UNKNOWN",
    userMessage: error instanceof Error ? error.message : String(error),
    suggestedActions: [],
  };
}
