import { describe, expect, it } from "vitest";
import { createKestrelError, type KestrelError } from "../../application/errors/kestrel-error.js";
import type { ErrorViewModel, ViewModel } from "../presentation/view-models.js";
import { renderSessionView } from "./session-renderer.js";

const AUTH_REQUIRED_ERROR = createKestrelError({
  code: "DM_GITHUB_AUTH_REQUIRED",
  category: "USER_ACTION_REQUIRED",
  userMessage: "GitHub authentication is required to continue",
  suggestedActions: ["Run 'kestrel auth login' to authenticate, then retry"],
  retryability: "NO_RETRY",
  recoveryStrategy: "USER_ACTION",
  severity: "ERROR",
});

const AUTH_EXPIRED_ERROR = createKestrelError({
  code: "DM_GITHUB_AUTH_EXPIRED",
  category: "USER_ACTION_REQUIRED",
  userMessage: "GitHub authentication has expired",
  suggestedActions: ["Re-run the command to re-authenticate"],
  retryability: "NO_RETRY",
  recoveryStrategy: "USER_ACTION",
  severity: "ERROR",
});

const AUTH_CANCELLED_ERROR = createKestrelError({
  code: "DM_GITHUB_AUTH_CANCELLED",
  category: "USER_ACTION_REQUIRED",
  userMessage: "Login was cancelled; the session remains active.",
  suggestedActions: ["Run /auth login when ready to authenticate again."],
  retryability: "NO_RETRY",
  recoveryStrategy: "USER_ACTION",
  severity: "INFO",
});

function errorViewModel(error: KestrelError): ErrorViewModel {
  return {
    kind: "error",
    code: error.code,
    userMessage: error.userMessage,
    suggestedActions: error.suggestedActions,
  };
}

describe("renderSessionView — auth-status", () => {
  it("maps NOT_CONNECTED to /auth login recovery", () => {
    expect(
      renderSessionView({
        kind: "auth-status",
        connected: false,
        login: null,
        detail: "NOT_CONNECTED",
      }),
    ).toMatchObject({
      text: expect.stringContaining("/auth login"),
      recoveryCommand: "/auth login",
    });
  });

  it("maps EXPIRED to /auth login recovery", () => {
    expect(
      renderSessionView({
        kind: "auth-status",
        connected: false,
        login: null,
        detail: "EXPIRED",
      }),
    ).toMatchObject({
      text: expect.stringContaining("/auth login"),
      recoveryCommand: "/auth login",
    });
  });

  it("does not recommend the shell-style auth login command", () => {
    expect(
      renderSessionView({
        kind: "auth-status",
        connected: false,
        login: null,
        detail: "NOT_CONNECTED",
      }).text,
    ).not.toContain("kestrel auth login");
  });
});

describe("renderSessionView — error", () => {
  it("maps DM_GITHUB_AUTH_REQUIRED to /auth login recovery", () => {
    expect(renderSessionView(errorViewModel(AUTH_REQUIRED_ERROR))).toMatchObject({
      text: expect.not.stringContaining("kestrel auth login"),
      recoveryCommand: "/auth login",
    });
  });

  it("does not turn a missing GitHub client configuration into a circular login recovery", () => {
    const configurationError = createKestrelError({
      code: "DM_GITHUB_AUTH_REQUIRED",
      category: "USER_ACTION_REQUIRED",
      userMessage: "GitHub authentication is not configured",
      suggestedActions: ["Set GITHUB_CLIENT_ID and run the command again"],
      retryability: "NO_RETRY",
      recoveryStrategy: "USER_ACTION",
      severity: "ERROR",
    });

    const rendered = renderSessionView(errorViewModel(configurationError));

    expect(rendered.text).toContain("GitHub authentication is not configured");
    expect(rendered.text).toContain("Set GITHUB_CLIENT_ID and run the command again");
    expect(rendered.text).not.toContain("Run /auth login to continue.");
    expect(rendered.recoveryCommand).toBeUndefined();
  });

  it("maps DM_GITHUB_AUTH_EXPIRED to /auth login recovery", () => {
    expect(renderSessionView(errorViewModel(AUTH_EXPIRED_ERROR))).toMatchObject({
      text: expect.not.stringContaining("kestrel auth login"),
      recoveryCommand: "/auth login",
    });
  });

  it("returns neutral output for DM_GITHUB_AUTH_CANCELLED, not error", () => {
    expect(renderSessionView(errorViewModel(AUTH_CANCELLED_ERROR))).toMatchObject({
      kind: "output",
    });
  });

  it("returns an error view for non-auth errors", () => {
    const networkError = createKestrelError({
      code: "DM_NETWORK_UNAVAILABLE",
      category: "TRANSIENT",
      userMessage: "Network is unavailable",
      suggestedActions: ["Check your connection and retry"],
      retryability: "RETRYABLE",
      recoveryStrategy: "RETRY",
      severity: "WARNING",
    });
    expect(renderSessionView(errorViewModel(networkError))).toMatchObject({
      kind: "error",
    });
  });
});

describe("renderSessionView — unique guidance", () => {
  it("translates kestrel auth login tokens and keeps surrounding guidance", () => {
    const error = createKestrelError({
      code: "DM_GITHUB_AUTH_REQUIRED",
      category: "USER_ACTION_REQUIRED",
      userMessage: "GitHub authentication is required to continue",
      suggestedActions: ["Run 'kestrel auth login' to authenticate, then retry"],
      retryability: "NO_RETRY",
      recoveryStrategy: "USER_ACTION",
      severity: "ERROR",
    });
    const rendered = renderSessionView(errorViewModel(error));
    expect(rendered.text).not.toContain("kestrel auth login");
    expect(rendered.text).toContain("to authenticate, then retry");
    expect(rendered.text).toContain("Run '/auth login' to authenticate, then retry");
  });

  it("preserves every suggestedAction and never drops surrounding guidance", () => {
    const error = createKestrelError({
      code: "DM_GITHUB_AUTH_REQUIRED",
      category: "USER_ACTION_REQUIRED",
      userMessage: "Auth missing",
      suggestedActions: [
        "Run 'kestrel auth login' to authenticate, then retry",
        "Check the GitHub status page if the failure persists",
        "Use a personal access token as a fallback",
      ],
      retryability: "NO_RETRY",
      recoveryStrategy: "USER_ACTION",
      severity: "ERROR",
    });
    const rendered = renderSessionView(errorViewModel(error));
    expect(rendered.text).toContain("to authenticate, then retry");
    expect(rendered.text).toContain("Check the GitHub status page if the failure persists");
    expect(rendered.text).toContain("Use a personal access token as a fallback");
  });

  it("translates kestrel auth status into /auth status", () => {
    const error = createKestrelError({
      code: "DM_NETWORK_UNAVAILABLE",
      category: "TRANSIENT",
      userMessage: "Network is unavailable",
      suggestedActions: ["Run `kestrel auth status` to re-check"],
      retryability: "RETRYABLE",
      recoveryStrategy: "RETRY",
      severity: "WARNING",
    });
    const rendered = renderSessionView(errorViewModel(error));
    expect(rendered.text).toContain("Run `/auth status` to re-check");
    expect(rendered.text).not.toContain("kestrel auth status");
  });

  it("deduplicates only an identical generated recovery line", () => {
    const error = createKestrelError({
      code: "DM_GITHUB_AUTH_REQUIRED",
      category: "USER_ACTION_REQUIRED",
      userMessage: "Auth missing",
      suggestedActions: ["Run /auth login to continue."],
      retryability: "NO_RETRY",
      recoveryStrategy: "USER_ACTION",
      severity: "ERROR",
    });
    const rendered = renderSessionView(errorViewModel(error));
    const occurrences = rendered.text.split("Run /auth login to continue.").length - 1;
    expect(occurrences).toBe(1);
  });

  it("keeps unique guidance even when it is not a literal duplicate", () => {
    const error = createKestrelError({
      code: "DM_GITHUB_AUTH_REQUIRED",
      category: "USER_ACTION_REQUIRED",
      userMessage: "Auth missing",
      suggestedActions: [
        "Run /auth login, then re-run the command",
        "Verify your network connection",
      ],
      retryability: "NO_RETRY",
      recoveryStrategy: "USER_ACTION",
      severity: "ERROR",
    });
    const rendered = renderSessionView(errorViewModel(error));
    expect(rendered.text).toContain("- Run /auth login, then re-run the command");
    expect(rendered.text).toContain("Run /auth login to continue.");
    expect(rendered.text).toContain("- Verify your network connection");
  });
});

describe("renderSessionView — device-authorization", () => {
  it("includes the verification URI and user code once", () => {
    const view: ViewModel = {
      kind: "device-authorization",
      verificationUri: "https://github.com/login/device",
      userCode: "ABCD-1234",
    };
    const rendered = renderSessionView(view);
    expect(rendered.text).toContain("https://github.com/login/device");
    expect(rendered.text).toContain("ABCD-1234");
    expect(rendered.text.split("https://github.com/login/device").length - 1).toBe(1);
    expect(rendered.text.split("ABCD-1234").length - 1).toBe(1);
  });

  it("never includes the device code or token", () => {
    const view: ViewModel = {
      kind: "device-authorization",
      verificationUri: "https://github.com/login/device",
      userCode: "ABCD-1234",
    };
    const rendered = renderSessionView(view);
    expect(rendered.text.toLowerCase()).not.toContain("device_code");
    expect(rendered.text.toLowerCase()).not.toContain("device code");
    expect(rendered.text.toLowerCase()).not.toContain("token");
  });

  it("exposes /auth login recovery for device-authorization view", () => {
    expect(
      renderSessionView({
        kind: "device-authorization",
        verificationUri: "https://github.com/login/device",
        userCode: "ABCD-1234",
      }).recoveryCommand,
    ).toBe("/auth login");
  });
});

describe("renderSessionView — non-auth views", () => {
  it("renders recommendation views via the plain renderer", () => {
    expect(
      renderSessionView({
        kind: "recommendation",
        recommendationId: "rec-1",
        challengeId: "ch-1",
        title: "Refactor the auth gateway",
        description: "Issue details",
        repository: "octocat/hello-world",
        issueNumber: 42,
        issueUrl: "https://github.com/octocat/hello-world/issues/42",
        challengeType: "BUG_FIX",
        language: "TypeScript",
        mood: "QUICK_WIN",
        confidence: 0.9,
        reasons: ["matches recent merges"],
      }),
    ).toMatchObject({ kind: "output" });
  });

  it("returns neutral output for verification messages", () => {
    expect(renderSessionView({ kind: "verification", text: "ok" })).toMatchObject({
      kind: "output",
      text: "ok",
    });
  });
});

describe("renderSessionView — recoveryCommand", () => {
  it("is undefined when no recovery applies", () => {
    const view: ViewModel = {
      kind: "journey",
      entries: [],
    };
    const rendered = renderSessionView(view);
    expect(rendered.kind).toBe("output");
    expect(rendered.recoveryCommand).toBeUndefined();
  });
});
