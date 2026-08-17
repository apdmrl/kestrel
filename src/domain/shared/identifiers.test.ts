import { describe, expect, it } from "vitest";
import { parseChallengeId, parseEventId, parseHandoffId, parseMissionId } from "./identifiers.js";

const factories = [
  ["parseMissionId", parseMissionId],
  ["parseChallengeId", parseChallengeId],
  ["parseEventId", parseEventId],
  ["parseHandoffId", parseHandoffId],
] as const;

describe("identifiers", () => {
  it.each(factories)("%s rejects an empty string", (_name, parse) => {
    const result = parse("");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toContain("ID");
    }
  });

  it.each(factories)("%s rejects whitespace-only input", (_name, parse) => {
    const result = parse("   \t  ");
    expect(result.ok).toBe(false);
  });

  it.each(factories)("%s accepts a non-empty value unchanged", (_name, parse) => {
    const result = parse("abc-123");
    expect(result).toEqual({ ok: true, value: "abc-123" });
  });
});
