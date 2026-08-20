import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
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
import {
  FileSystemRecommendationStore,
  migrateLegacyRecommendation,
} from "./file-system-recommendation-store.js";
import { toPersistedRecommendation } from "./mappers/mission-mapper.js";

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

describe("migrateLegacyRecommendation", () => {
  function collectDiagnostics(): { messages: string[]; onDiagnostic: (m: string) => void } {
    const messages: string[] = [];
    return { messages, onDiagnostic: (m) => messages.push(m) };
  }

  it("migrates a legacy single-latest snapshot into the per-id store", async () => {
    const legacyPath = join(dir, "recommendation.json");
    const store = new FileSystemRecommendationStore(join(dir, "recommendations"));
    const challenge = makeChallenge("challenge-a", "Fix crash on startup");
    const recommendation = makeRecommendation(challenge, 0.9);
    await writeFile(
      legacyPath,
      JSON.stringify({
        schemaVersion: 1,
        recommendationId: challenge.id,
        recommendation: toPersistedRecommendation(recommendation),
      }),
      "utf8",
    );
    const { messages, onDiagnostic } = collectDiagnostics();

    expect(await migrateLegacyRecommendation(legacyPath, store, onDiagnostic)).toBe(true);
    expect(messages).toEqual([]);
    // The legacy file is consumed only after the identical snapshot is installed.
    await expect(stat(legacyPath)).rejects.toThrow();
    expect((await store.load(challenge.id))?.confidence).toBe(0.9);
  });

  it("returns false when no legacy file exists", async () => {
    const store = new FileSystemRecommendationStore(join(dir, "recommendations"));
    await expect(
      migrateLegacyRecommendation(join(dir, "recommendation.json"), store),
    ).resolves.toBe(false);
  });

  it("rejects a mismatched envelope id vs snapshot challenge id as corruption", async () => {
    const legacyPath = join(dir, "recommendation.json");
    const store = new FileSystemRecommendationStore(join(dir, "recommendations"));
    const challenge = makeChallenge("challenge-a", "Fix crash on startup");
    const recommendation = makeRecommendation(challenge, 0.9);
    // The envelope claims id "other-id", but the snapshot's challenge id differs.
    await writeFile(
      legacyPath,
      JSON.stringify({
        schemaVersion: 1,
        recommendationId: "other-id",
        recommendation: toPersistedRecommendation(recommendation),
      }),
      "utf8",
    );
    const { messages, onDiagnostic } = collectDiagnostics();

    expect(await migrateLegacyRecommendation(legacyPath, store, onDiagnostic)).toBe(false);
    // The inconsistent legacy evidence is preserved, not deleted.
    await expect(stat(legacyPath)).resolves.toBeDefined();
    expect(await readdir(join(dir, "recommendations")).catch(() => [])).toEqual([]);
    expect(messages.length).toBeGreaterThan(0);
  });

  it("preserves legacy state on a conflicting per-id record without deleting it", async () => {
    const legacyPath = join(dir, "recommendation.json");
    const store = new FileSystemRecommendationStore(join(dir, "recommendations"));
    const challenge = makeChallenge("challenge-a", "Fix crash on startup");
    // A newer immutable snapshot already owns the id.
    await store.save(makeRecommendation(challenge, 0.9));
    const differing = makeRecommendation(challenge, 0.4);
    await writeFile(
      legacyPath,
      JSON.stringify({
        schemaVersion: 1,
        recommendationId: challenge.id,
        recommendation: toPersistedRecommendation(differing),
      }),
      "utf8",
    );
    const { messages, onDiagnostic } = collectDiagnostics();

    expect(await migrateLegacyRecommendation(legacyPath, store, onDiagnostic)).toBe(false);
    // The conflicting legacy file is NOT deleted; the per-id snapshot is unchanged.
    await expect(stat(legacyPath)).resolves.toBeDefined();
    expect((await store.load(challenge.id))?.confidence).toBe(0.9);
    expect(messages.length).toBeGreaterThan(0);
  });
});
