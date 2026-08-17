import { describe, expect, it } from "vitest";
import type { RepositoryIdentity } from "../../domain/challenge/repository-identity.js";
import { matchPullRequest } from "./pr-matcher.js";

const repository: RepositoryIdentity = {
  provider: "github",
  owner: "octocat",
  name: "hello-world",
};

function input(overrides: Partial<Parameters<typeof matchPullRequest>[0]> = {}) {
  return {
    repository,
    prRepository: repository,
    expectedAuthor: "octocat",
    prAuthor: "octocat",
    missionCommits: ["abc", "def"],
    prCommits: ["abc"],
    missionBranch: "kestrel/1-fix",
    prBranch: "kestrel/1-fix",
    ...overrides,
  };
}

describe("matchPullRequest", () => {
  it("matches on an exact commit", () => {
    const result = matchPullRequest(input());
    expect(result.kind).toBe("match");
    if (result.kind === "match") {
      expect(result.confidence).toBeGreaterThan(0);
    }
  });

  it("matches multiple mission commits in a PR", () => {
    const result = matchPullRequest(input({ prCommits: ["abc", "def"] }));
    expect(result.kind).toBe("match");
    if (result.kind === "match") {
      expect(result.confidence).toBe(1);
    }
  });

  it("matches even with a renamed branch", () => {
    const result = matchPullRequest(input({ prBranch: "renamed-branch" }));
    expect(result.kind).toBe("match");
  });

  it("rejects a wrong author", () => {
    const result = matchPullRequest(input({ prAuthor: "someone-else" }));
    expect(result.kind).toBe("no-match");
  });

  it("rejects a wrong repository", () => {
    const result = matchPullRequest(
      input({ prRepository: { provider: "github", owner: "x", name: "y" } }),
    );
    expect(result.kind).toBe("no-match");
  });

  it("rejects a branch-name-only false positive", () => {
    const result = matchPullRequest(input({ prCommits: [] }));
    expect(result.kind).toBe("no-match");
  });

  it("rejects unavailable commits", () => {
    const result = matchPullRequest(input({ prCommits: [], missionCommits: [] }));
    expect(result.kind).toBe("no-match");
  });
});
