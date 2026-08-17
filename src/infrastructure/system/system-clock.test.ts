import { describe, expect, it } from "vitest";
import { parseIsoDateTime } from "../../domain/shared/time.js";
import { SystemClock } from "./system-clock.js";

describe("SystemClock", () => {
  it("returns a valid UTC ISO timestamp close to wall-clock time", () => {
    const before = Date.now();
    const now = new SystemClock().now();
    const after = Date.now();
    expect(parseIsoDateTime(now).ok).toBe(true);
    const ms = Date.parse(now);
    expect(ms).toBeGreaterThanOrEqual(before - 1000);
    expect(ms).toBeLessThanOrEqual(after + 1000);
  });
});
