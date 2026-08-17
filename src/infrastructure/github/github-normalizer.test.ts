import { describe, expect, it } from "vitest";
import type { ChallengeId } from "../../domain/shared/identifiers.js";
import { inferChallengeType, normalizeIssue, type RawGitHubIssue } from "./github-normalizer.js";

const repository = { provider: "github" as const, owner: "octocat", name: "hello-world" };

function issue(overrides: Partial<RawGitHubIssue>): RawGitHubIssue {
  return {
    id: 1001,
    number: 42,
    title: "Fix crash",
    body: "It crashes",
    state: "open",
    labels: [{ name: "bug" }],
    html_url: "https://github.com/octocat/hello-world/issues/42",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-02T00:00:00Z",
    ...overrides,
  };
}

describe("normalizeIssue", () => {
  it("normalizes a valid issue into a challenge", () => {
    const result = normalizeIssue({ issue: issue({}), repository, issueId: "c1" as ChallengeId });
    expect(result.kind).toBe("challenge");
    if (result.kind === "challenge") {
      expect(result.challenge.title).toBe("Fix crash");
      expect(result.challenge.source.issueNumber).toBe(42);
      expect(result.challenge.source.externalId).toBe("1001");
      expect(result.challenge.type).toBe("BUG_FIX");
    }
  });

  it("skips a PR-shaped search result", () => {
    const result = normalizeIssue({
      issue: issue({ pull_request: { url: "https://api.github.com/pulls/1" } }),
      repository,
      issueId: "c1" as ChallengeId,
    });
    expect(result).toEqual({ kind: "skip", reason: "pull_request" });
  });

  it("skips a closed issue", () => {
    const result = normalizeIssue({
      issue: issue({ state: "closed" }),
      repository,
      issueId: "c1" as ChallengeId,
    });
    expect(result).toEqual({ kind: "skip", reason: "closed" });
  });

  it("skips an archived repository", () => {
    const result = normalizeIssue({
      issue: issue({}),
      repository,
      archived: true,
      issueId: "c1" as ChallengeId,
    });
    expect(result).toEqual({ kind: "skip", reason: "archived" });
  });

  it("preserves a missing language as undefined", () => {
    const result = normalizeIssue({ issue: issue({}), repository, issueId: "c1" as ChallengeId });
    if (result.kind === "challenge") {
      expect(result.challenge.language).toBeUndefined();
    }
  });
});

describe("inferChallengeType", () => {
  it("infers testing from test labels", () => {
    expect(inferChallengeType(["test", "coverage"])).toBe("TESTING");
  });

  it("infers documentation from doc labels", () => {
    expect(inferChallengeType(["documentation"])).toBe("DOCUMENTATION");
  });

  it("defaults to bug fix", () => {
    expect(inferChallengeType(["bug"])).toBe("BUG_FIX");
    expect(inferChallengeType([])).toBe("BUG_FIX");
  });
});
