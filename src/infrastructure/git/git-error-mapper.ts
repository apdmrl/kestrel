import { createKestrelError, isKestrelError } from "../../application/errors/kestrel-error.js";
import type { KestrelError } from "../../application/errors/kestrel-error.js";

/** Map a process-level failure (from ProcessRunner) to a Git-specific error. */
export function mapGitProcessError(error: unknown): KestrelError {
  if (isKestrelError(error)) {
    if (error.code === "DM_PROCESS_NOT_FOUND") {
      return createKestrelError({
        code: "DM_GIT_NOT_FOUND",
        category: "USER_ACTION_REQUIRED",
        userMessage: "Git is not installed or not on PATH",
        suggestedActions: ["Install Git and add it to PATH"],
        retryability: "NO_RETRY",
        recoveryStrategy: "USER_ACTION",
        severity: "ERROR",
      });
    }
    if (error.code === "DM_PROCESS_TIMEOUT") {
      return createKestrelError({
        code: "DM_GIT_TIMEOUT",
        category: "TRANSIENT",
        userMessage: "The Git command timed out",
        suggestedActions: ["Retry the operation"],
        retryability: "RETRYABLE",
        recoveryStrategy: "RETRY",
        severity: "ERROR",
      });
    }
    if (error.code === "DM_PROCESS_CANCELLED") {
      return createKestrelError({
        code: "DM_GIT_CANCELLED",
        category: "USER_ACTION_REQUIRED",
        userMessage: "The Git command was cancelled",
        suggestedActions: ["Run the command again when ready"],
        retryability: "NO_RETRY",
        recoveryStrategy: "USER_ACTION",
        severity: "INFO",
      });
    }
  }
  return createKestrelError({
    code: "DM_GIT_FATAL",
    category: "EXTERNAL_STATE_CHANGED",
    userMessage: "A Git command failed unexpectedly",
    suggestedActions: ["Check the repository state and retry"],
    retryability: "NO_RETRY",
    recoveryStrategy: "MANUAL_INTERVENTION",
    severity: "ERROR",
    cause: error,
  });
}

/** Map a non-zero Git exit code (with stderr) to a Git-specific error. */
export function mapGitExitCode(exitCode: number, stderr: string): KestrelError {
  const lower = stderr.toLowerCase();
  if (/authentication failed|permission denied|could not read username|publickey/i.test(lower)) {
    return createKestrelError({
      code: "DM_GIT_AUTH_FAILED",
      category: "USER_ACTION_REQUIRED",
      userMessage: "Git authentication failed",
      suggestedActions: ["Check your Git credentials"],
      retryability: "NO_RETRY",
      recoveryStrategy: "REAUTHENTICATE",
      severity: "ERROR",
    });
  }
  if (/conflict|would be overwritten|not something we can merge|unmerged paths/i.test(lower)) {
    return createKestrelError({
      code: "DM_GIT_CONFLICT",
      category: "EXTERNAL_STATE_CHANGED",
      userMessage: "A Git operation conflicted with existing work",
      suggestedActions: ["Resolve the conflict before retrying"],
      retryability: "NO_RETRY",
      recoveryStrategy: "MANUAL_INTERVENTION",
      severity: "ERROR",
    });
  }
  return createKestrelError({
    code: "DM_GIT_FATAL",
    category: "EXTERNAL_STATE_CHANGED",
    userMessage: "A Git command failed",
    suggestedActions: ["Check the repository state and retry"],
    retryability: "NO_RETRY",
    recoveryStrategy: "MANUAL_INTERVENTION",
    severity: "ERROR",
    debugContext: { exitCode },
  });
}
