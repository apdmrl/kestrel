import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createChallenge } from "../../domain/challenge/challenge.js";
import {
  createRecommendation,
  snapshotRecommendation,
} from "../../domain/recommendation/recommendation.js";
import type { Challenge } from "../../domain/challenge/challenge.js";
import type { ChallengeId } from "../../domain/shared/identifiers.js";
import type { IsoDateTime } from "../../domain/shared/time.js";
import type { RecommendationSnapshot } from "../../domain/recommendation/recommendation.js";
import { FileSystemRecommendationStore } from "./file-system-recommendation-store.js";

const evaluatedAt = "2026-08-15T10:00:00Z" as IsoDateTime;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kestrel-recommendation-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeChallenge(id: string, title: string): Challenge {
  const result = createChallenge({
    id: id as ChallengeId,
    externalId: "1",
    repository: { provider: "github", owner: "o", name: "n" },
    issueNumber: 1,
    canonicalUrl: "https://github.com/o/n/issues/1",
    title,
    description: "desc",
    type: "BUG_FIX",
    createdAt: "2026-08-01T00:00:00Z" as IsoDateTime,
    updatedAt: "2026-08-01T00:00:00Z" as IsoDateTime,
  });
  if (!result.ok) {
    throw new Error("expected ok");
  }
  return result.value;
}

function makeRecommendation(challenge: Challenge, confidence: number): RecommendationSnapshot {
  const result = createRecommendation({
    challenge,
    mood: "QUICK_WIN",
    signalResults: [{ name: "interest", value: confidence, confidence: 0.8, reason: "matches" }],
    confidence,
    evaluatedAt,
  });
  if (!result.ok) {
    throw new Error("expected ok");
  }
  return snapshotRecommendation(result.value);
}

describe("FileSystemRecommendationStore", () => {
  it("loads independent recommendations by immutable id", async () => {
    const store = new FileSystemRecommendationStore(join(dir, "recommendations"));
    const challengeA = makeChallenge("challenge-a", "Fix crash on startup");
    const challengeB = makeChallenge("challenge-b", "Add documentation");
    const recommendationA = makeRecommendation(challengeA, 0.9);
    const recommendationB = makeRecommendation(challengeB, 0.7);

    await store.save(recommendationA);
    await store.save(recommendationB);

    // A later save must never replace an earlier snapshot: both load by id.
    const loadedA = await store.load(challengeA.id);
    const loadedB = await store.load(challengeB.id);
    expect(loadedA?.challenge.title).toBe("Fix crash on startup");
    expect(loadedB?.challenge.title).toBe("Add documentation");
    expect(loadedA?.confidence).toBe(0.9);
    expect(loadedB?.confidence).toBe(0.7);
  });

  it("is idempotent when the same id is saved with identical content", async () => {
    const store = new FileSystemRecommendationStore(join(dir, "recommendations"));
    const challenge = makeChallenge("challenge-a", "Fix crash on startup");
    const recommendation = makeRecommendation(challenge, 0.9);

    await store.save(recommendation);
    await store.save(recommendation);
    await store.save(recommendation);

    const loaded = await store.load(challenge.id);
    expect(loaded?.confidence).toBe(0.9);
    expect(await readdir(join(dir, "recommendations"))).toHaveLength(1);
  });

  it("rejects conflicting content saved under the same immutable id", async () => {
    const store = new FileSystemRecommendationStore(join(dir, "recommendations"));
    const challenge = makeChallenge("challenge-a", "Fix crash on startup");
    const first = makeRecommendation(challenge, 0.9);
    const conflicting = makeRecommendation(challenge, 0.2);

    await store.save(first);
    await expect(store.save(conflicting)).rejects.toMatchObject({ code: "DM_STORE_CONFLICT" });

    // The original snapshot must remain authoritative.
    const loaded = await store.load(challenge.id);
    expect(loaded?.confidence).toBe(0.9);
  });

  it("returns undefined for an unknown id", async () => {
    const store = new FileSystemRecommendationStore(join(dir, "recommendations"));
    await expect(store.load("challenge-unknown" as ChallengeId)).resolves.toBeUndefined();
  });

  it("rejects identifiers that are not safe file names", async () => {
    const store = new FileSystemRecommendationStore(join(dir, "recommendations"));
    const unsafe = makeRecommendation(makeChallenge("../escape", "bad"), 0.5);
    await expect(store.save(unsafe)).rejects.toMatchObject({ code: "DM_ILLEGAL_TRANSITION" });
  });
});
