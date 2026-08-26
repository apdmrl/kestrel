import { describe, expect, it } from "vitest";
import { renderPlain } from "./plain-renderer.js";
import { renderJson } from "./json-renderer.js";

const ansi = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m");

describe("renderPlain", () => {
  it("renders a recommendation without ANSI", () => {
    const output = renderPlain({
      kind: "recommendation",
      recommendationId: "c1",
      challengeId: "c1",
      title: "Fix crash",
      mood: "QUICK_WIN",
      confidence: 0.8,
      reasons: ["matches interests"],
    });
    expect(output).toContain("Fix crash");
    expect(output).toContain("c1");
    expect(output).not.toMatch(ansi);
  });

  it("renders Unicode and paths with spaces", () => {
    const output = renderPlain({
      kind: "mission",
      id: "m1",
      status: "IN_PROGRESS",
      title: "Fix café crash in /home/dev/my repo",
    });
    expect(output).toContain("café");
    expect(output).toContain("/home/dev/my repo");
  });

  it("renders a connected auth status with the login", () => {
    const output = renderPlain({
      kind: "auth-status",
      connected: true,
      login: "octocat",
      detail: "CONNECTED",
    });
    expect(output).toContain("octocat");
    expect(output).not.toMatch(ansi);
  });

  it("renders a disconnected auth status with the command that connects", () => {
    const output = renderPlain({
      kind: "auth-status",
      connected: false,
      login: null,
      detail: "NOT_CONNECTED",
    });
    expect(output).toContain("Not connected");
    expect(output).toContain("kestrel auth login");
  });

  it("distinguishes an expired credential from never having connected", () => {
    const expired = renderPlain({
      kind: "auth-status",
      connected: false,
      login: null,
      detail: "EXPIRED",
    });
    expect(expired).toContain("expired");
    expect(expired).not.toContain("Not connected");
  });

  it("renders a logged-out auth status", () => {
    const output = renderPlain({
      kind: "auth-status",
      connected: false,
      login: null,
      detail: "LOGGED_OUT",
    });
    expect(output).toContain("Logged out");
  });

  it("renders device authorization guidance with the uri and code", () => {
    const output = renderPlain({
      kind: "device-authorization",
      verificationUri: "https://github.com/login/device",
      userCode: "ABCD-1234",
    });
    expect(output).toContain("https://github.com/login/device");
    expect(output).toContain("ABCD-1234");
    expect(output).not.toMatch(ansi);
  });

  it("never claims a browser opened, which is reported as its own notice", () => {
    const output = renderPlain({
      kind: "device-authorization",
      verificationUri: "https://github.com/login/device",
      userCode: "ABCD-1234",
    });
    expect(output.toLowerCase()).not.toContain("browser");
  });

  it("prints the guidance on a single line so it is never split or repeated", () => {
    const output = renderPlain({
      kind: "device-authorization",
      verificationUri: "https://github.com/login/device",
      userCode: "ABCD-1234",
    });
    expect(output.split("\n")).toHaveLength(1);
  });
});

describe("renderJson", () => {
  it("emits a parseable versioned envelope with no ANSI", () => {
    const output = renderJson({
      kind: "progress",
      counts: { accepted: 1, completed: 0, submitted: 0, linked: 0, merged: 0, abandoned: 0 },
    });
    const parsed = JSON.parse(output) as {
      schemaVersion: number;
      ok: boolean;
      data: { kind: string };
    };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.kind).toBe("progress");
    expect(output).not.toMatch(ansi);
  });

  it("emits a classified error envelope", () => {
    const output = renderJson({
      kind: "error",
      code: "DM_NETWORK_UNAVAILABLE",
      userMessage: "GitHub could not be reached",
      suggestedActions: ["retry"],
    });
    const parsed = JSON.parse(output) as { ok: boolean; error: { code: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("DM_NETWORK_UNAVAILABLE");
  });

  it("carries auth status in the standard data envelope", () => {
    const output = renderJson({
      kind: "auth-status",
      connected: true,
      login: "octocat",
      detail: "CONNECTED",
    });
    const parsed = JSON.parse(output) as {
      schemaVersion: number;
      ok: boolean;
      data: { kind: string; connected: boolean; login: string | null; detail: string };
    };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toEqual({
      kind: "auth-status",
      connected: true,
      login: "octocat",
      detail: "CONNECTED",
    });
  });

  it("emits a null login rather than omitting it when disconnected", () => {
    const output = renderJson({
      kind: "auth-status",
      connected: false,
      login: null,
      detail: "NOT_CONNECTED",
    });
    const parsed = JSON.parse(output) as { data: { login: string | null } };
    expect(parsed.data.login).toBeNull();
  });

  it("carries device authorization without a device code or token", () => {
    const output = renderJson({
      kind: "device-authorization",
      verificationUri: "https://github.com/login/device",
      userCode: "ABCD-1234",
    });
    const parsed = JSON.parse(output) as {
      ok: boolean;
      data: { kind: string; verificationUri: string; userCode: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.verificationUri).toBe("https://github.com/login/device");
    expect(Object.keys(parsed.data).sort()).toEqual(["kind", "userCode", "verificationUri"]);
  });
});
