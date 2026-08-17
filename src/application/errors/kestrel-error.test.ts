import { describe, expect, it } from "vitest";
import type { ErrorCategory } from "./error-codes.js";
import {
  createKestrelError,
  isKestrelError,
  KestrelError,
  redactSecrets,
} from "./kestrel-error.js";

const categories: ErrorCategory[] = [
  "TRANSIENT",
  "USER_ACTION_REQUIRED",
  "RECOVERABLE_STATE",
  "CONFLICT",
  "INVALID_INPUT",
  "EXTERNAL_STATE_CHANGED",
  "FATAL",
];

describe("KestrelError", () => {
  it("constructs every required category", () => {
    for (const category of categories) {
      const error = createKestrelError({
        code: "DM_STATE_CORRUPTED",
        category,
        userMessage: "Something needs attention",
        suggestedActions: category === "FATAL" ? [] : ["Retry the operation"],
        retryability: "NO_RETRY",
        recoveryStrategy: "NONE",
        severity: "ERROR",
      });
      expect(error.category).toBe(category);
      expect(isKestrelError(error)).toBe(true);
      expect(error).toBeInstanceOf(KestrelError);
    }
  });

  it("rejects an empty suggested-action list for a recoverable error", () => {
    expect(() =>
      createKestrelError({
        code: "DM_NETWORK_UNAVAILABLE",
        category: "TRANSIENT",
        userMessage: "Network is down",
        suggestedActions: [],
        retryability: "RETRYABLE",
        recoveryStrategy: "RETRY",
        severity: "ERROR",
      }),
    ).toThrow();
  });

  it("rejects a whitespace-only suggested action for a recoverable error", () => {
    expect(() =>
      createKestrelError({
        code: "DM_MISSION_PREPARATION_INTERRUPTED",
        category: "RECOVERABLE_STATE",
        userMessage: "Interrupted",
        suggestedActions: ["   "],
        retryability: "NO_RETRY",
        recoveryStrategy: "RESUME",
        severity: "WARNING",
      }),
    ).toThrow();
  });

  it("redacts secret-shaped keys recursively", () => {
    const redacted = redactSecrets({
      safe: "ok",
      token: "abc",
      nested: { password: "hunter2", items: [{ secret: "x", other: "y" }] },
      list: [1, 2],
      authorization: { bearer: "z" },
    });
    expect(redacted).toEqual({
      safe: "ok",
      token: "[REDACTED]",
      nested: { password: "[REDACTED]", items: [{ secret: "[REDACTED]", other: "y" }] },
      list: [1, 2],
      authorization: "[REDACTED]",
    });
  });

  it("stores a redacted debug context on construction", () => {
    const error = createKestrelError({
      code: "DM_GITHUB_AUTH_EXPIRED",
      category: "USER_ACTION_REQUIRED",
      userMessage: "Re-authenticate",
      suggestedActions: ["Run kestrel auth"],
      retryability: "NO_RETRY",
      recoveryStrategy: "REAUTHENTICATE",
      severity: "ERROR",
      debugContext: { token: "secret-token", url: "https://api.github.com" },
    });
    expect(error.debugContext).toEqual({ token: "[REDACTED]", url: "https://api.github.com" });
  });
});
