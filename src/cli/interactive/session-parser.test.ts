import { describe, expect, it } from "vitest";
import { parseSessionCommand } from "./session-parser.js";

describe("parseSessionCommand session-local commands", () => {
  it("parses /help", () => {
    expect(parseSessionCommand("/help")).toEqual({ kind: "help" });
  });

  it("parses /clear", () => {
    expect(parseSessionCommand("/clear")).toEqual({ kind: "clear" });
  });

  it("parses /exit", () => {
    expect(parseSessionCommand("/exit")).toEqual({ kind: "exit" });
  });

  it("parses /quit as exit", () => {
    expect(parseSessionCommand("/quit")).toEqual({ kind: "exit" });
  });
});

describe("parseSessionCommand tokenizer", () => {
  it("trims surrounding whitespace", () => {
    expect(parseSessionCommand("  /help  ")).toEqual({ kind: "help" });
  });

  it("rejects input without a leading slash", () => {
    const result = parseSessionCommand("progress");
    expect(result).toBeInstanceOf(Error);
    if (result instanceof Error) {
      expect(result.message).toContain("/progress");
    }
  });

  it("rejects an unterminated quote", () => {
    const result = parseSessionCommand('/mission accept --id "unterminated');
    expect(result).toBeInstanceOf(Error);
    if (result instanceof Error) {
      expect(result.message).toMatch(/unterminated/i);
    }
  });

  it("rejects an option missing its value", () => {
    const result = parseSessionCommand("/mission break-lock --id");
    expect(result).toBeInstanceOf(Error);
    if (result instanceof Error) {
      expect(result.message).toMatch(/--id/);
    }
  });
});

describe("parseSessionCommand handler commands", () => {
  it("parses progress", () => {
    expect(parseSessionCommand("/progress")).toEqual({ kind: "progress" });
  });

  it("parses find with mood and type", () => {
    expect(parseSessionCommand("/find --mood QUICK_WIN --type bug")).toEqual({
      kind: "find",
      mood: "QUICK_WIN",
      type: "bug",
    });
  });

  it("parses find with default mood", () => {
    expect(parseSessionCommand("/find --type feature")).toEqual({
      kind: "find",
      mood: "QUICK_WIN",
      type: "feature",
    });
  });

  it("parses mission current", () => {
    expect(parseSessionCommand("/mission current")).toEqual({ kind: "mission-current" });
  });

  it("parses mission current with id", () => {
    expect(parseSessionCommand("/mission current --id m1")).toEqual({
      kind: "mission-current",
      missionId: "m1",
    });
  });

  it("parses mission accept with a required recommendation id", () => {
    expect(parseSessionCommand("/mission accept --id rec-42")).toEqual({
      kind: "mission-accept",
      recommendationId: "rec-42",
    });
  });

  it("rejects mission accept without a recommendation id", () => {
    const result = parseSessionCommand("/mission accept");
    expect(result).toBeInstanceOf(Error);
    if (result instanceof Error) {
      expect(result.message).toMatch(/--id/);
    }
  });

  it("parses mission prepare, resume, and complete with id", () => {
    expect(parseSessionCommand("/mission prepare --id m1")).toEqual({
      kind: "mission-prepare",
      missionId: "m1",
    });
    expect(parseSessionCommand("/mission resume --id m1")).toEqual({
      kind: "mission-resume",
      missionId: "m1",
    });
    expect(parseSessionCommand("/mission complete --id m1")).toEqual({
      kind: "mission-complete",
      missionId: "m1",
    });
  });

  it("parses mission abandon with reason", () => {
    expect(parseSessionCommand('/mission abandon --reason "not enough time"')).toEqual({
      kind: "mission-abandon",
      reason: "not enough time",
    });
  });

  it("parses mission break-lock with required id", () => {
    expect(parseSessionCommand("/mission break-lock --id m1")).toEqual({
      kind: "mission-break-lock",
      missionId: "m1",
    });
  });

  it("parses agent brief with hypothesis", () => {
    expect(parseSessionCommand('/agent brief --hypothesis "hyp 1"')).toEqual({
      kind: "agent-brief",
      hypothesis: "hyp 1",
    });
  });

  it("parses verify submission, link, and merge with pr number", () => {
    expect(parseSessionCommand("/verify submission --pr 42")).toEqual({
      kind: "verify-submission",
      prNumber: 42,
    });
    expect(parseSessionCommand("/verify link --pr 42")).toEqual({
      kind: "verify-link",
      prNumber: 42,
    });
    expect(parseSessionCommand("/verify merge --pr 42")).toEqual({
      kind: "verify-merge",
      prNumber: 42,
    });
  });

  it("parses journey", () => {
    expect(parseSessionCommand("/journey")).toEqual({ kind: "journey" });
  });

  it("parses preferences get", () => {
    expect(parseSessionCommand("/preferences get")).toEqual({ kind: "preferences-get" });
  });

  it("parses preferences set with language and mode", () => {
    expect(parseSessionCommand("/preferences set --language en --mode focused")).toEqual({
      kind: "preferences-set",
      language: "en",
      mode: "focused",
    });
  });
});

describe("parseSessionCommand quote boundaries", () => {
  it("rejects a quoted command token before tokenization", () => {
    expect(parseSessionCommand('"/help"')).toBeInstanceOf(Error);
  });

  it("preserves quoted option values that begin with dashes", () => {
    expect(parseSessionCommand('/mission abandon --reason "--blocked"')).toEqual({
      kind: "mission-abandon",
      reason: "--blocked",
    });
    expect(parseSessionCommand("/mission abandon --reason '--blocked'")).toEqual({
      kind: "mission-abandon",
      reason: "--blocked",
    });
  });

  it("rejects unknown options", () => {
    expect(parseSessionCommand("/progress --unexpected value")).toBeInstanceOf(Error);
  });
});

it("does not treat trailing empty quotes as quoted option syntax", () => {
  expect(parseSessionCommand('/mission abandon --reason --unexpected""')).toBeInstanceOf(Error);
});

it("preserves a literal NUL at the start of a quoted value", () => {
  expect(parseSessionCommand('/mission abandon --reason "\u0000blocked"')).toEqual({
    kind: "mission-abandon",
    reason: "\u0000blocked",
  });
});

it("returns an error for an incomplete agent option", () => {
  expect(parseSessionCommand("/agent brief --id")).toBeInstanceOf(Error);
});
