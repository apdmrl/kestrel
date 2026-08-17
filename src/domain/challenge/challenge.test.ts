import { describe, expect, it } from "vitest";
import type { ChallengeId } from "../shared/identifiers.js";
import type { IsoDateTime } from "../shared/time.js";
import type { RepositoryIdentity } from "./repository-identity.js";
import { createChallenge, type CreateChallengeInput } from "./challenge.js";

const repository: RepositoryIdentity = { provider: "github", owner: "org", name: "repo" };

function validChallenge(): CreateChallengeInput {
  return {
    id: "ch-1" as ChallengeId,
    externalId: "12345",
    repository,
    issueNumber: 42,
    canonicalUrl: "https://github.com/org/repo/issues/42",
    title: "Fix crash on startup",
    description: "The app crashes when the config is missing.",
    type: "BUG_FIX",
    labels: ["bug", "bug", " good-first-issue ", ""],
    language: "typescript",
    topics: ["runtime", "runtime", " cli "],
    createdAt: "2026-08-01T00:00:00Z" as IsoDateTime,
    updatedAt: "2026-08-15T00:00:00Z" as IsoDateTime,
  };
}

function expectChallenge(value: unknown) {
  const result = value as { ok: true; value: { labels: string[]; topics: string[] } };
  expect(result.ok).toBe(true);
  return result.value;
}

describe("Challenge", () => {
  it("strips duplicate, blank, and untrimmed labels and topics", () => {
    const challenge = expectChallenge(createChallenge(validChallenge()));
    expect(challenge.labels).toEqual(["bug", "good-first-issue"]);
    expect(challenge.topics).toEqual(["runtime", "cli"]);
  });

  it("preserves GitHub provenance in the source reference", () => {
    const challenge = expectChallenge(createChallenge(validChallenge())) as unknown as {
      source: Record<string, unknown>;
    };
    expect(challenge.source).toEqual({
      provider: "github",
      externalId: "12345",
      repository,
      issueNumber: 42,
      canonicalUrl: "https://github.com/org/repo/issues/42",
    });
  });

  it("rejects a challenge whose updatedAt precedes createdAt", () => {
    const input = validChallenge();
    const result = createChallenge({
      ...input,
      createdAt: "2026-08-15T00:00:00Z" as IsoDateTime,
      updatedAt: "2026-08-01T00:00:00Z" as IsoDateTime,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an empty title", () => {
    const result = createChallenge({ ...validChallenge(), title: "   " });
    expect(result.ok).toBe(false);
  });

  it("contains no time-sensitive enrichment fields", () => {
    const challenge = expectChallenge(createChallenge(validChallenge()));
    expect(Object.keys(challenge).sort()).toEqual([
      "createdAt",
      "description",
      "id",
      "labels",
      "language",
      "repository",
      "source",
      "title",
      "topics",
      "type",
      "updatedAt",
    ]);
    expect(challenge).not.toHaveProperty("stars");
    expect(challenge).not.toHaveProperty("repositoryHealth");
  });

  it("is immune to caller mutation of input arrays and repository", () => {
    const labels = ["bug"];
    const mutableRepository = { provider: "github" as const, owner: "o", name: "n" };
    const input = { ...validChallenge(), labels, repository: mutableRepository };
    const challenge = expectChallenge(createChallenge(input)) as unknown as {
      labels: string[];
      repository: { owner: string };
    };

    labels.push("extra");
    mutableRepository.owner = "MUTATED";

    expect(challenge.labels).toEqual(["bug"]);
    expect(challenge.repository.owner).toBe("o");
  });
});
