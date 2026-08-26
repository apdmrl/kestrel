import { describe, expect, it } from "vitest";
import { shouldStartSession } from "./session-start.js";

describe("shouldStartSession", () => {
  it("starts the shell when no arguments are provided", () => {
    expect(shouldStartSession([])).toBe(true);
  });

  it("starts the shell when only --no-browser is provided", () => {
    expect(shouldStartSession(["--no-browser"])).toBe(true);
  });

  it("starts the shell when only --no-interactive is provided", () => {
    expect(shouldStartSession(["--no-interactive"])).toBe(true);
  });

  it("starts the shell when both policy flags are provided", () => {
    expect(shouldStartSession(["--no-browser", "--no-interactive"])).toBe(true);
  });

  it("delegates to Commander when a subcommand is present", () => {
    expect(shouldStartSession(["--no-browser", "auth", "login"])).toBe(false);
  });

  it("delegates to Commander when --json is present", () => {
    expect(shouldStartSession(["--json"])).toBe(false);
  });
});
