import { describe, expect, it } from "vitest";
import { isoDateTimeFromDate, parseIsoDateTime } from "./time.js";

describe("IsoDateTime", () => {
  it.each([
    "2026-08-15T10:20:30Z",
    "2026-08-15T10:20:30.123Z",
    "2026-08-15T10:20:30+02:00",
    "2026-08-15T10:20:30.000-05:30",
  ])("accepts a valid ISO timestamp %s", (value) => {
    const result = parseIsoDateTime(value);
    expect(result.ok).toBe(true);
  });

  it.each([
    "",
    "   ",
    "not-a-date",
    "2026-13-45T00:00:00Z",
    "2026-01-01",
    "2026-01-01T00:00:00",
    "15-08-2026T10:20:30Z",
  ])("rejects a malformed timestamp %s", (value) => {
    const result = parseIsoDateTime(value);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toContain("TIMESTAMP");
    }
  });

  it("derives a valid timestamp from a Date via the trusted path", () => {
    const value = isoDateTimeFromDate(new Date("2026-08-15T10:20:30Z"));
    expect(parseIsoDateTime(value).ok).toBe(true);
  });
});
