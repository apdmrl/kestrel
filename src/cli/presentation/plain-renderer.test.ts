import { describe, expect, it } from "vitest";
import { renderPlain } from "./plain-renderer.js";
import type {
  AuthStatusViewModel,
  ErrorViewModel,
} from "./view-models.js";

/**
 * Exact regression assertions for the plain renderer.
 *
 * These tests pin the full, byte-for-byte output of every renderer branch the
 * CLI surfaces during unauthenticated startup and offline recovery. A future
 * change that flips a casing, a colon, or a connecting string will fail here
 * before the change can ship, so the contract Kestrel relies on to keep its
 * plain-text and JSON outputs in lock-step remains observable.
 */
describe("renderPlain — exact regression assertions", () => {
  const notConnected: AuthStatusViewModel = {
    kind: "auth-status",
    connected: false,
    login: null,
    detail: "NOT_CONNECTED",
  };

  it("renders the NOT_CONNECTED auth status verbatim", () => {
    expect(renderPlain(notConnected)).toBe(
      ["Not connected to GitHub", "Run 'kestrel auth login' to connect"].join("\n"),
    );
  });

  it("renders the EXPIRED auth status verbatim", () => {
    const expired: AuthStatusViewModel = {
      kind: "auth-status",
      connected: false,
      login: null,
      detail: "EXPIRED",
    };
    expect(renderPlain(expired)).toBe(
      [
        "The stored GitHub credential has expired",
        "Run 'kestrel auth login' to authenticate again",
      ].join("\n"),
    );
  });

  it("renders the CONNECTED auth status verbatim", () => {
    const connected: AuthStatusViewModel = {
      kind: "auth-status",
      connected: true,
      login: "octocat",
      detail: "CONNECTED",
    };
    expect(renderPlain(connected)).toBe("Connected to GitHub as octocat");
  });

  it("renders the LOGGED_OUT auth status verbatim", () => {
    const loggedOut: AuthStatusViewModel = {
      kind: "auth-status",
      connected: false,
      login: null,
      detail: "LOGGED_OUT",
    };
    expect(renderPlain(loggedOut)).toBe("Logged out of GitHub");
  });

  it("renders the unauthenticated classified-error view verbatim", () => {
    const error: ErrorViewModel = {
      kind: "error",
      code: "DM_GITHUB_AUTH_REQUIRED",
      userMessage: "GitHub authentication is required to continue",
      suggestedActions: ["Run 'kestrel auth login' to authenticate, then retry"],
    };
    expect(renderPlain(error)).toBe(
      [
        "Error [DM_GITHUB_AUTH_REQUIRED]: GitHub authentication is required to continue",
        "Actions:",
        "- Run 'kestrel auth login' to authenticate, then retry",
      ].join("\n"),
    );
  });

  it("never adds any field that is not explicitly rendered", () => {
    // The plain renderer must stay free of metadata like schemaVersion, ok,
    // or envelope fields. The JSON envelope is its only structured sibling;
    // plain output is human-facing and exact.
    const text = renderPlain(notConnected);
    expect(text).not.toContain("schemaVersion");
    expect(text).not.toContain('"ok"');
    expect(text).not.toContain('"data"');
  });
});