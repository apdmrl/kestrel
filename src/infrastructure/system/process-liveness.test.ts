import { describe, expect, it } from "vitest";
import { platform } from "node:os";
import {
  defaultIsProcessAlive,
  parseStartTicks,
  readProcessIdentity,
  type ProcessIdentity,
} from "./process-liveness.js";

describe("parseStartTicks", () => {
  it("extracts exact field 22 from a stat line whose command contains spaces and parens", () => {
    const comm = "weird ) name (x)";
    const fields = [
      "R",
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "11",
      "12",
      "13",
      "14",
      "15",
      "16",
      "17",
      "FIELDTWENTYTWO",
      "20",
      "21",
    ];
    const stat = "123 (" + comm + ") " + fields.join(" ");
    expect(parseStartTicks(stat)).toBe("FIELDTWENTYTWO");
  });

  it("preserves leading zeros and returns the ticks as a decimal string", () => {
    const stat = "1 (x) R 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 0042 19 20";
    expect(parseStartTicks(stat)).toBe("0042");
  });

  it("returns undefined when the stat line has no closing paren", () => {
    expect(parseStartTicks("1 (unterminated R 0 1 2")).toBeUndefined();
  });
});

describe("readProcessIdentity", () => {
  it("returns a boot id and start ticks for the current process on Linux", () => {
    const identity = readProcessIdentity(process.pid);
    if (platform() !== "linux") {
      expect(identity).toBeUndefined();
      return;
    }
    expect(identity).toBeDefined();
    expect((identity as ProcessIdentity).bootId).toBeTypeOf("string");
    expect((identity as ProcessIdentity).startTicks).toMatch(/^\d+$/);
  });

  it("returns undefined for an absent pid", () => {
    if (platform() !== "linux") {
      expect(readProcessIdentity(process.pid)).toBeUndefined();
      return;
    }
    expect(readProcessIdentity(99999999)).toBeUndefined();
  });
});

describe("defaultIsProcessAlive", () => {
  it("reports a nonexistent pid as dead", () => {
    expect(defaultIsProcessAlive(99999999, { bootId: "x", startTicks: "1" })).toBe(false);
  });

  it("treats an exact live pid + identity match as live regardless of createdAt ordering", () => {
    const identity = readProcessIdentity(process.pid);
    if (platform() !== "linux" || identity === undefined) {
      return;
    }
    expect(defaultIsProcessAlive(process.pid, identity)).toBe(true);
  });

  it("classifies the same live pid with a different boot id as stale", () => {
    if (platform() !== "linux" || readProcessIdentity(process.pid) === undefined) {
      return;
    }
    expect(
      defaultIsProcessAlive(process.pid, {
        bootId: "00000000-0000-0000-0000-000000000000",
        startTicks: "1",
      }),
    ).toBe(false);
  });

  it("classifies the same live pid with a different start ticks as stale", () => {
    const identity = readProcessIdentity(process.pid);
    if (platform() !== "linux" || identity === undefined) {
      return;
    }
    expect(defaultIsProcessAlive(process.pid, { bootId: identity.bootId, startTicks: "1" })).toBe(
      false,
    );
  });

  it("treats a live pid without a legacy identity as conservatively live", () => {
    expect(defaultIsProcessAlive(process.pid, undefined)).toBe(true);
  });

  it("treats an absent pid without identity as stale", () => {
    expect(defaultIsProcessAlive(99999999, undefined)).toBe(false);
  });

  it("treats a malformed boot id on a live pid as unknown/live (fail closed)", () => {
    if (platform() !== "linux" || readProcessIdentity(process.pid) === undefined) {
      return;
    }
    expect(defaultIsProcessAlive(process.pid, { bootId: "not-a-uuid", startTicks: "1" })).toBe(
      true,
    );
  });

  it("treats a malformed start ticks on a live pid as unknown/live (fail closed)", () => {
    if (platform() !== "linux" || readProcessIdentity(process.pid) === undefined) {
      return;
    }
    expect(
      defaultIsProcessAlive(process.pid, {
        bootId: "00000000-0000-0000-0000-000000000000",
        startTicks: "not-decimal",
      }),
    ).toBe(true);
  });

  it("still classifies a well-formed, verified identity mismatch as stale", () => {
    if (platform() !== "linux" || readProcessIdentity(process.pid) === undefined) {
      return;
    }
    // A canonical UUID boot id that differs from the live pid's is a verified
    // (well-formed) mismatch, so it remains a stale/reused pid.
    expect(
      defaultIsProcessAlive(process.pid, {
        bootId: "00000000-0000-0000-0000-000000000000",
        startTicks: "999999",
      }),
    ).toBe(false);
  });
});
