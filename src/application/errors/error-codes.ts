/** Recovery-semantic categories from the architecture spec (section 22). */
export type ErrorCategory =
  | "TRANSIENT"
  | "USER_ACTION_REQUIRED"
  | "RECOVERABLE_STATE"
  | "CONFLICT"
  | "INVALID_INPUT"
  | "EXTERNAL_STATE_CHANGED"
  | "FATAL";

/** Stable Kestrel error codes. Every classified error uses exactly one. */
export type ErrorCode =
  | "DM_NETWORK_UNAVAILABLE"
  | "DM_GITHUB_AUTH_EXPIRED"
  | "DM_GITHUB_RATE_LIMITED"
  | "DM_GIT_NOT_FOUND"
  | "DM_MISSION_PREPARATION_INTERRUPTED"
  | "DM_MISSION_LOCKED"
  | "DM_CHALLENGE_CLOSED"
  | "DM_STATE_CORRUPTED"
  | "DM_STATE_VERSION_UNSUPPORTED"
  | "DM_STATE_WRITE_FAILED"
  | "DM_STATE_READ_FAILED"
  | "DM_STORE_CONFLICT"
  | "DM_MISSION_LOCK_STALE"
  | "DM_PROCESS_NOT_FOUND"
  | "DM_PROCESS_TIMEOUT"
  | "DM_PROCESS_CANCELLED"
  | "DM_PROCESS_FAILED"
  | "DM_GIT_AUTH_FAILED"
  | "DM_GIT_CONFLICT"
  | "DM_GIT_FATAL"
  | "DM_GIT_TIMEOUT"
  | "DM_GIT_CANCELLED";

export type Retryability = "NO_RETRY" | "RETRYABLE" | "RETRY_WITH_BACKOFF";

export type RecoveryStrategy =
  "RETRY" | "REAUTHENTICATE" | "RESUME" | "USER_ACTION" | "MANUAL_INTERVENTION" | "NONE";

export type Severity = "INFO" | "WARNING" | "ERROR" | "FATAL";

/** Categories a caller can act on; only FATAL has no recovery path. */
export function isRecoverableCategory(category: ErrorCategory): boolean {
  return category !== "FATAL";
}
