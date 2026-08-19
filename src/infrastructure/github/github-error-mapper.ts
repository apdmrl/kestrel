import { createKestrelError, isKestrelError } from "../../application/errors/kestrel-error.js";
import type { KestrelError } from "../../application/errors/kestrel-error.js";

interface ErrorLike {
  name?: string;
  status?: number;
  message?: string;
  response?: { headers?: Record<string, string | number | undefined> };
}

function headerValue(error: ErrorLike, name: string): string | undefined {
  const value = error.response?.headers?.[name];
  return value === undefined ? undefined : String(value);
}

function isRequestFailure(error: ErrorLike): boolean {
  return error.name === "RequestError" || error.name === "FetchError" || error.status === undefined;
}

function isTimeout(error: ErrorLike): boolean {
  return (
    error.name === "AbortError" ||
    (error.message ?? "").toLowerCase().includes("timeout") ||
    (error.message ?? "").toLowerCase().includes("aborted")
  );
}

function rateLimited(error: ErrorLike): boolean {
  return headerValue(error, "x-ratelimit-remaining") === "0";
}

function abuseLimited(error: ErrorLike): boolean {
  return (
    headerValue(error, "retry-after") !== undefined ||
    (error.message ?? "").toLowerCase().includes("abuse")
  );
}

/** Map an Octokit/HTTP failure to a stable, recovery-oriented KestrelError. */
export function mapGitHubError(error: unknown, signal?: AbortSignal): KestrelError {
  if (isKestrelError(error)) {
    return error;
  }
  // A user-initiated cancellation of an in-flight request is a classified
  // cancellation (exit 130), never a timeout.
  if (signal?.aborted === true) {
    return createKestrelError({
      code: "DM_PROCESS_CANCELLED",
      category: "USER_ACTION_REQUIRED",
      userMessage: "Operation cancelled",
      suggestedActions: ["Run the command again when ready"],
      retryability: "NO_RETRY",
      recoveryStrategy: "USER_ACTION",
      severity: "INFO",
    });
  }
  const shape = (error ?? {}) as ErrorLike;
  const status = shape.status;

  if (isTimeout(shape)) {
    return createKestrelError({
      code: "DM_GITHUB_TIMEOUT",
      category: "TRANSIENT",
      userMessage: "The GitHub request timed out",
      suggestedActions: ["Retry the operation"],
      retryability: "RETRY_WITH_BACKOFF",
      recoveryStrategy: "RETRY",
      severity: "ERROR",
    });
  }
  if (isRequestFailure(shape)) {
    return createKestrelError({
      code: "DM_NETWORK_UNAVAILABLE",
      category: "TRANSIENT",
      userMessage: "GitHub could not be reached",
      suggestedActions: ["Check your network connection and retry"],
      retryability: "RETRY_WITH_BACKOFF",
      recoveryStrategy: "RETRY",
      severity: "ERROR",
    });
  }
  if (status === 401) {
    return createKestrelError({
      code: "DM_GITHUB_AUTH_EXPIRED",
      category: "USER_ACTION_REQUIRED",
      userMessage: "GitHub authentication has expired",
      suggestedActions: ["Re-run the command to re-authenticate"],
      retryability: "NO_RETRY",
      recoveryStrategy: "REAUTHENTICATE",
      severity: "ERROR",
    });
  }
  if (status === 403 && rateLimited(shape)) {
    const reset = headerValue(shape, "x-ratelimit-reset");
    return createKestrelError({
      code: "DM_GITHUB_RATE_LIMITED",
      category: "TRANSIENT",
      userMessage: "GitHub API rate limit exceeded",
      suggestedActions: ["Wait for the rate limit to reset and retry"],
      retryability: "RETRY_WITH_BACKOFF",
      recoveryStrategy: "RETRY",
      severity: "ERROR",
      ...(reset !== undefined ? { debugContext: { rateLimitReset: reset } } : {}),
    });
  }
  if (status === 403 && abuseLimited(shape)) {
    return createKestrelError({
      code: "DM_GITHUB_ABUSE_LIMIT",
      category: "TRANSIENT",
      userMessage: "GitHub detected a secondary rate-limit or abuse threshold",
      suggestedActions: ["Wait before retrying"],
      retryability: "RETRY_WITH_BACKOFF",
      recoveryStrategy: "RETRY",
      severity: "ERROR",
    });
  }
  if (status === 404) {
    return createKestrelError({
      code: "DM_GITHUB_NOT_FOUND",
      category: "EXTERNAL_STATE_CHANGED",
      userMessage: "The requested GitHub resource was not found",
      suggestedActions: ["Verify the resource still exists"],
      retryability: "NO_RETRY",
      recoveryStrategy: "MANUAL_INTERVENTION",
      severity: "ERROR",
    });
  }
  if (status === 422) {
    return createKestrelError({
      code: "DM_GITHUB_VALIDATION",
      category: "INVALID_INPUT",
      userMessage: "GitHub rejected the request as invalid",
      suggestedActions: ["Check the request parameters"],
      retryability: "NO_RETRY",
      recoveryStrategy: "USER_ACTION",
      severity: "ERROR",
    });
  }
  return createKestrelError({
    code: "DM_GITHUB_FATAL",
    category: "EXTERNAL_STATE_CHANGED",
    userMessage: "A GitHub request failed",
    suggestedActions: ["Check the request and retry"],
    retryability: "NO_RETRY",
    recoveryStrategy: "MANUAL_INTERVENTION",
    severity: "ERROR",
    cause: error,
  });
}
