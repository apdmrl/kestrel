import { describe, expect, it } from "vitest";
import { createChallenge } from "../../domain/challenge/challenge.js";
import {
  createRecommendation,
  snapshotRecommendation,
} from "../../domain/recommendation/recommendation.js";
import type { Challenge } from "../../domain/challenge/challenge.js";
import type { ChallengeId } from "../../domain/shared/identifiers.js";
import type { MissionId } from "../../domain/shared/identifiers.js";
import type { IsoDateTime } from "../../domain/shared/time.js";
import type { RecommendationSnapshot } from "../../domain/recommendation/recommendation.js";
import { Mission } from "../../domain/mission/mission.js";
import { buildAgentBrief } from "./build-agent-brief.js";

const acceptedAt = "2026-08-15T10:00:00Z" as IsoDateTime;
const clock = { now: () => acceptedAt };

function makeChallenge(type: "BUG_FIX" | "TESTING" | "DOCUMENTATION" = "BUG_FIX"): Challenge {
  const result = createChallenge({
    id: "c1" as ChallengeId,
    externalId: "1",
    repository: { provider: "github", owner: "octocat", name: "hello-world" },
    issueNumber: 42,
    canonicalUrl: "https://github.com/octocat/hello-world/issues/42",
    title: "Fix crash",
    description: "It crashes on startup",
    type,
    createdAt: "2026-08-01T00:00:00Z" as IsoDateTime,
    updatedAt: "2026-08-01T00:00:00Z" as IsoDateTime,
  });
  if (!result.ok) {
    throw new Error("expected ok");
  }
  return result.value;
}

function makeRecommendation(challenge: Challenge): RecommendationSnapshot {
  const result = createRecommendation({
    challenge,
    mood: "QUICK_WIN",
    signalResults: [{ name: "interest", value: 0.9, confidence: 0.8, reason: "matches" }],
    confidence: 0.8,
    evaluatedAt: acceptedAt,
  });
  if (!result.ok) {
    throw new Error("expected ok");
  }
  return snapshotRecommendation(result.value);
}

function acceptedMission(
  mode: "GUIDED" | "EXPERT",
  type: "BUG_FIX" | "TESTING" | "DOCUMENTATION" = "BUG_FIX",
): Mission {
  const result = Mission.accept({
    id: "m1" as MissionId,
    challengeSnapshot: makeChallenge(type),
    recommendationSnapshot: makeRecommendation(makeChallenge(type)),
    mode,
    acceptedAt,
  });
  if (!result.ok) {
    throw new Error("expected ok");
  }
  return result.value;
}

describe("buildAgentBrief", () => {
  it("produces a schema-versioned, policy-versioned, deterministic brief", () => {
    const brief = buildAgentBrief(clock, { mission: acceptedMission("GUIDED") });
    expect(brief.schemaVersion).toBe(1);
    expect(brief.policyVersion).toBe(1);
    expect(brief.generatedAt).toBe(acceptedAt);
    expect(brief.objective).toContain("octocat/hello-world");
  });

  it("differs between guided and expert modes", () => {
    const guided = buildAgentBrief(clock, { mission: acceptedMission("GUIDED") });
    const expert = buildAgentBrief(clock, { mission: acceptedMission("EXPERT") });
    expect(guided.agentBehavior).not.toEqual(expert.agentBehavior);
    expect(guided.investigationGoals.length).toBeGreaterThan(expert.investigationGoals.length);
  });

  it("uses the mission policy for each type", () => {
    const bug = buildAgentBrief(clock, { mission: acceptedMission("GUIDED", "BUG_FIX") });
    const doc = buildAgentBrief(clock, { mission: acceptedMission("GUIDED", "DOCUMENTATION") });
    expect(bug.objective).toContain("bug");
    expect(doc.objective).toContain("documentation");
    expect(bug.workflow).not.toEqual(doc.workflow);
  });

  it("includes an optional hypothesis", () => {
    const brief = buildAgentBrief(clock, {
      mission: acceptedMission("GUIDED"),
      hypothesis: "a null pointer deref",
    });
    expect(brief.developerHypothesis).toBe("a null pointer deref");
    expect(
      buildAgentBrief(clock, { mission: acceptedMission("GUIDED") }).developerHypothesis,
    ).toBeUndefined();
  });

  it("does not invent claims unsupported by mission data", () => {
    const brief = buildAgentBrief(clock, { mission: acceptedMission("GUIDED") });
    const serialized = JSON.stringify(brief);
    expect(serialized).not.toContain("stars");
    expect(serialized).not.toContain("impact");
  });
});
