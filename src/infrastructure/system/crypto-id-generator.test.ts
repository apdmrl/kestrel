import { describe, expect, it } from "vitest";
import { CryptoIdGenerator } from "./crypto-id-generator.js";

describe("CryptoIdGenerator", () => {
  const generator = new CryptoIdGenerator();

  it("produces non-empty unique mission IDs", () => {
    const a = generator.newMissionId();
    const b = generator.newMissionId();
    expect(a).not.toBe("");
    expect(b).not.toBe("");
    expect(a).not.toBe(b);
  });

  it("produces non-empty unique IDs for every purpose", () => {
    const mission = generator.newMissionId();
    const challenge = generator.newChallengeId();
    const event = generator.newEventId();
    const handoff = generator.newHandoffId();
    const values = [mission, challenge, event, handoff];
    for (const value of values) {
      expect(value.length).toBeGreaterThan(0);
    }
    expect(new Set(values).size).toBe(4);
  });
});
