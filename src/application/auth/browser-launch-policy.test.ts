import { describe, expect, it } from "vitest";
import { shouldOpenBrowser } from "./browser-launch-policy.js";

const enabled = {
  noBrowserFlag: false,
  envDisabled: false,
  json: false,
  interactive: true,
} as const;

describe("shouldOpenBrowser", () => {
  it("opens the browser for an interactive session with no suppression", () => {
    expect(shouldOpenBrowser(enabled)).toBe(true);
  });

  it("does not open the browser when --no-browser is passed", () => {
    expect(shouldOpenBrowser({ ...enabled, noBrowserFlag: true })).toBe(false);
  });

  it("does not open the browser when KESTREL_NO_BROWSER is set", () => {
    expect(shouldOpenBrowser({ ...enabled, envDisabled: true })).toBe(false);
  });

  it("does not open the browser in --json mode, which is the machine contract", () => {
    expect(shouldOpenBrowser({ ...enabled, json: true })).toBe(false);
  });

  it("does not open the browser in a non-interactive session", () => {
    expect(shouldOpenBrowser({ ...enabled, interactive: false })).toBe(false);
  });

  it("stays suppressed when several suppression sources combine", () => {
    expect(
      shouldOpenBrowser({
        noBrowserFlag: true,
        envDisabled: true,
        json: true,
        interactive: false,
      }),
    ).toBe(false);
  });
});
