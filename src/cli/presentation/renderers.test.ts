import { describe, expect, it } from "vitest";
import { renderPlain } from "./plain-renderer.js";
import { renderJson } from "./json-renderer.js";

const ansi = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m");

describe("renderPlain", () => {
  it("renders a recommendation without ANSI", () => {
    const output = renderPlain({
      kind: "recommendation",
      challengeId: "c1",
      title: "Fix crash",
      mood: "QUICK_WIN",
      confidence: 0.8,
      reasons: ["matches interests"],
    });
    expect(output).toContain("Fix crash");
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
});
