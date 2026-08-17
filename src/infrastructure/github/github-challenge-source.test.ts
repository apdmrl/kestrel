import { describe, expect, it } from "vitest";
import type { SearchIntent } from "../../domain/discovery/search-intent.js";
import { createSearchIntent } from "../../domain/discovery/search-intent.js";
import { createExplicitPreferences } from "../../domain/preferences/preferences.js";
import { createChallenge } from "../../domain/challenge/challenge.js";
import type { ChallengeId } from "../../domain/shared/identifiers.js";
import type { IsoDateTime } from "../../domain/shared/time.js";
import type { OctokitLike } from "./octokit-gateway.js";
import { GithubChallengeSource } from "./github-challenge-source.js";

const clock = { now: () => "2026-08-15T10:00:00Z" as IsoDateTime };
const idGenerator = {
  newMissionId: () => "m" as never,
  newChallengeId: () => "c1" as ChallengeId,
  newEventId: () => "e" as never,
  newHandoffId: () => "h" as never,
  newTransactionId: () => "t" as never,
  newEvidenceId: () => "ev" as never,
};

function intent(): SearchIntent {
  const prefs = createExplicitPreferences({});
  const result = createSearchIntent({
    mood: "QUICK_WIN",
    explicitPreferences: prefs.ok ? prefs.value : ({} as never),
    pageBudget: 5,
  });
  if (!result.ok) {
    throw new Error("expected ok");
  }
  return result.value;
}

class FakeOctokit implements OctokitLike {
  searchItems: Array<Record<string, unknown>> = [];
  repo: Record<string, unknown> = {};

  async request(route: string, _options?: Record<string, unknown>) {
    if (route === "GET /search/issues") {
      return { status: 200, data: { items: this.searchItems }, headers: {} };
    }
    if (route.startsWith("GET /repos/")) {
      return { status: 200, data: this.repo, headers: {} };
    }
    throw new Error("unexpected route " + route);
  }
}

describe("GithubChallengeSource", () => {
  it("searches and normalizes issues, skipping PRs and closed issues", async () => {
    const octokit = new FakeOctokit();
    octokit.searchItems = [
      {
        id: 1001,
        number: 42,
        title: "Fix crash",
        body: "crash",
        state: "open",
        labels: [{ name: "bug" }],
        html_url: "https://github.com/octocat/hello-world/issues/42",
        repository_url: "https://api.github.com/repos/octocat/hello-world",
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-02T00:00:00Z",
      },
      {
        id: 1002,
        number: 43,
        title: "A PR",
        state: "open",
        pull_request: { url: "x" },
        repository_url: "https://api.github.com/repos/octocat/hello-world",
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-02T00:00:00Z",
      },
    ];
    const source = new GithubChallengeSource(octokit, clock, idGenerator);
    const challenges = await source.search(intent());
    expect(challenges).toHaveLength(1);
    expect(challenges[0]?.title).toBe("Fix crash");
  });

  it("enriches a challenge with live repository observations", async () => {
    const octokit = new FakeOctokit();
    octokit.repo = { archived: false, stargazers_count: 10000, open_issues_count: 30 };
    const challenge = createChallenge({
      id: "c1" as ChallengeId,
      externalId: "1",
      repository: { provider: "github", owner: "octocat", name: "hello-world" },
      issueNumber: 1,
      canonicalUrl: "https://github.com/octocat/hello-world/issues/1",
      title: "t",
      description: "d",
      type: "BUG_FIX",
      createdAt: "2026-08-01T00:00:00Z" as IsoDateTime,
      updatedAt: "2026-08-01T00:00:00Z" as IsoDateTime,
    });
    if (!challenge.ok) {
      throw new Error("expected ok");
    }
    const source = new GithubChallengeSource(octokit, clock, idGenerator);
    const context = await source.enrich(challenge.value);
    expect(context.repositoryHealth).toBe(1);
    expect(context.repositoryInterest).toBeGreaterThan(0);
    expect(context.competingWork).toBe(30);
  });

  it("marks an archived repository as unhealthy", async () => {
    const octokit = new FakeOctokit();
    octokit.repo = { archived: true, stargazers_count: 0, open_issues_count: 0 };
    const challenge = createChallenge({
      id: "c1" as ChallengeId,
      externalId: "1",
      repository: { provider: "github", owner: "octocat", name: "hello-world" },
      issueNumber: 1,
      canonicalUrl: "https://github.com/octocat/hello-world/issues/1",
      title: "t",
      description: "d",
      type: "BUG_FIX",
      createdAt: "2026-08-01T00:00:00Z" as IsoDateTime,
      updatedAt: "2026-08-01T00:00:00Z" as IsoDateTime,
    });
    if (!challenge.ok) {
      throw new Error("expected ok");
    }
    const source = new GithubChallengeSource(octokit, clock, idGenerator);
    const context = await source.enrich(challenge.value);
    expect(context.repositoryHealth).toBe(0);
  });
});
