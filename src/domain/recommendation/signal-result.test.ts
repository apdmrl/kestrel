import { describe, expect, it } from "vitest";
import { createSignalResult } from "./signal-result.js";

describe("SignalResult", () => {
  it("accepts a valid result", () => {
    const result = createSignalResult({
      name: "language-match",
      value: 0.7,
      confidence: 0.8,
      reason: "matches preferred language",
    });
    expect(result).toEqual({
      ok: true,
      value: {
        name: "language-match",
        value: 0.7,
        confidence: 0.8,
        reason: "matches preferred language",
      },
    });
  });

  it.each([-0.1, 1.5, Number.NaN])("rejects an out-of-range value %s", (value) => {
    expect(createSignalResult({ name: "x", value, confidence: 0.5, reason: "r" }).ok).toBe(false);
  });

  it.each([-0.1, 1.5, Number.NaN])("rejects an out-of-range confidence %s", (confidence) => {
    expect(createSignalResult({ name: "x", value: 0.5, confidence, reason: "r" }).ok).toBe(false);
  });

  it("rejects an empty reason", () => {
    expect(createSignalResult({ name: "x", value: 0.5, confidence: 0.5, reason: "  " }).ok).toBe(
      false,
    );
  });

  it("rejects an empty name", () => {
    expect(createSignalResult({ name: "", value: 0.5, confidence: 0.5, reason: "r" }).ok).toBe(
      false,
    );
  });
});
