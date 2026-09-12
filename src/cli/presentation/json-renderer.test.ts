import { describe, expect, it } from "vitest";
import { renderJson } from "./json-renderer.js";
import type { AuthStatusViewModel, ErrorViewModel } from "./view-models.js";

/**
 * Exact regression assertions for the JSON envelope.
 *
 * The renderer pins schemaVersion to 1 and forbids every additional
 * top-level field. A future change that adds a top-level envelope key —
 * for example a `meta`, `trace`, or `warnings` field — must fail here
 * before it can break downstream consumers that rely on the documented
 * `schemaVersion` / `ok` / (`data` | `error`) shape.
 */
describe("renderJson — exact regression assertions", () => {
  const notConnected: AuthStatusViewModel = {
    kind: "auth-status",
    connected: false,
    login: null,
    detail: "NOT_CONNECTED",
  };

  it("emits the NOT_CONNECTED auth status inside the versioned data envelope", () => {
    expect(JSON.parse(renderJson(notConnected))).toEqual({
      schemaVersion: 1,
      ok: true,
      data: notConnected,
    });
  });

  it("emits the EXPIRED auth status inside the versioned data envelope", () => {
    const expired: AuthStatusViewModel = {
      kind: "auth-status",
      connected: false,
      login: null,
      detail: "EXPIRED",
    };
    expect(JSON.parse(renderJson(expired))).toEqual({
      schemaVersion: 1,
      ok: true,
      data: expired,
    });
  });

  it("emits the CONNECTED auth status inside the versioned data envelope", () => {
    const connected: AuthStatusViewModel = {
      kind: "auth-status",
      connected: true,
      login: "octocat",
      detail: "CONNECTED",
    };
    expect(JSON.parse(renderJson(connected))).toEqual({
      schemaVersion: 1,
      ok: true,
      data: connected,
    });
  });

  it("emits the unauthenticated classified error inside the versioned error envelope", () => {
    const error: ErrorViewModel = {
      kind: "error",
      code: "DM_GITHUB_AUTH_REQUIRED",
      userMessage: "GitHub authentication is required to continue",
      suggestedActions: ["Run 'kestrel auth login' to authenticate, then retry"],
    };
    expect(JSON.parse(renderJson(error))).toEqual({
      schemaVersion: 1,
      ok: false,
      error: {
        code: "DM_GITHUB_AUTH_REQUIRED",
        userMessage: "GitHub authentication is required to continue",
        suggestedActions: ["Run 'kestrel auth login' to authenticate, then retry"],
      },
    });
  });

  it("keeps the top-level envelope keys exactly schemaVersion, ok, and (data | error)", () => {
    // Pin the exact top-level shape so a future field addition surfaces here.
    const okKeys = Object.keys(JSON.parse(renderJson(notConnected))).sort();
    expect(okKeys).toEqual(["data", "ok", "schemaVersion"]);

    const errorView: ErrorViewModel = {
      kind: "error",
      code: "DM_GITHUB_AUTH_REQUIRED",
      userMessage: "GitHub authentication is required to continue",
      suggestedActions: ["Run 'kestrel auth login' to authenticate, then retry"],
    };
    const errorKeys = Object.keys(JSON.parse(renderJson(errorView))).sort();
    expect(errorKeys).toEqual(["error", "ok", "schemaVersion"]);
  });

  it("never introduces a top-level field besides schemaVersion, ok, and (data | error)", () => {
    // Forbidden envelope keys a future change might accidentally add. Pinning
    // them by name keeps the schema stable across the renderer.
    const envelope = JSON.parse(renderJson(notConnected)) as Record<string, unknown>;
    expect(envelope).not.toHaveProperty("meta");
    expect(envelope).not.toHaveProperty("trace");
    expect(envelope).not.toHaveProperty("warnings");
    expect(envelope).not.toHaveProperty("timestamp");
    expect(envelope).not.toHaveProperty("version");
    expect(envelope).not.toHaveProperty("requestId");

    const errorEnvelope = JSON.parse(
      renderJson({
        kind: "error",
        code: "DM_GITHUB_AUTH_REQUIRED",
        userMessage: "GitHub authentication is required to continue",
        suggestedActions: ["Run 'kestrel auth login' to authenticate, then retry"],
      }),
    ) as Record<string, unknown>;
    expect(errorEnvelope).not.toHaveProperty("meta");
    expect(errorEnvelope).not.toHaveProperty("trace");
    expect(errorEnvelope).not.toHaveProperty("warnings");
    expect(errorEnvelope).not.toHaveProperty("timestamp");
    expect(errorEnvelope).not.toHaveProperty("version");
    expect(errorEnvelope).not.toHaveProperty("requestId");
  });
});
