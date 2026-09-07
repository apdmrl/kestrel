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

function openIssue(id: number): Record<string, unknown> {
  return {
    id,
    number: id,
    title: "Issue " + id,
    state: "open",
    labels: [{ name: "bug" }],
    html_url: "https://github.com/octocat/hello-world/issues/" + id,
    repository_url: "https://api.github.com/repos/octocat/hello-world",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-02T00:00:00Z",
  };
}

class FakeOctokit implements OctokitLike {
  searchItems: Array<Record<string, unknown>> = [];
  searchItemsByPage: Record<number, Array<Record<string, unknown>>> = {};
  repo: Record<string, unknown> = {};
  requests: Array<{ route: string; options: Record<string, unknown> | undefined }> = [];

  async request(route: string, options?: Record<string, unknown>) {
    this.requests.push({ route, options });
    if (route === "GET /search/issues") {
      const page = options?.page;
      const pageItems = typeof page === "number" ? this.searchItemsByPage[page] : undefined;
      return { status: 200, data: { items: pageItems ?? this.searchItems }, headers: {} };
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

  it("treats policy labels as alternatives", async () => {
    const preferences = createExplicitPreferences({ preferredLanguages: ["typescript"] });
    if (!preferences.ok) throw new Error("expected preferences");
    const searchIntent = createSearchIntent({
      mood: "QUICK_WIN",
      explicitPreferences: preferences.value,
      pageBudget: 5,
    });
    if (!searchIntent.ok) throw new Error("expected intent");

    const octokit = new FakeOctokit();
    const source = new GithubChallengeSource(octokit, clock, idGenerator);
    await source.search(searchIntent.value);

    expect(octokit.requests[0]?.options).toMatchObject({
      q: 'is:issue state:open language:typescript label:"bug","bug-fix","good first issue"',
    });
  });

  it("uses page budget with a fixed provider batch size", async () => {
    const octokit = new FakeOctokit();
    octokit.searchItemsByPage[1] = [
      openIssue(1001),
      openIssue(1002),
      { ...openIssue(1003), pull_request: { url: "x" } },
    ];
    octokit.searchItemsByPage[2] = [openIssue(1004)];
    const source = new GithubChallengeSource(octokit, clock, idGenerator);

    const challenges = await source.search(intent());

    expect(challenges).toHaveLength(3);
    const searchRequests = octokit.requests.filter(
      (request) => request.route === "GET /search/issues",
    );
    expect(searchRequests.map((request) => request.options?.page)).toEqual([1, 2]);
    expect(searchRequests.map((request) => request.options?.per_page)).toEqual([3, 3]);
  });

  it("deduplicates normalized candidates across pages", async () => {
    const octokit = new FakeOctokit();
    octokit.searchItemsByPage[1] = [openIssue(1001), openIssue(1001), openIssue(1002)];
    octokit.searchItemsByPage[2] = [openIssue(1002), openIssue(1002), openIssue(1003)];
    const source = new GithubChallengeSource(octokit, clock, idGenerator);

    const challenges = await source.search(intent());

    expect(challenges.map((challenge) => challenge.source.externalId)).toEqual([
      "1001",
      "1002",
      "1003",
    ]);
  });

  it("forwards the same signal on every discovery request", async () => {
    const octokit = new FakeOctokit();
    octokit.searchItemsByPage[1] = [openIssue(1001), openIssue(1001), openIssue(1002)];
    octokit.searchItemsByPage[2] = [openIssue(1002), openIssue(1002), openIssue(1003)];
    const controller = new AbortController();
    const source = new GithubChallengeSource(octokit, clock, idGenerator);

    await source.search(intent(), controller.signal);

    const searchRequests = octokit.requests.filter(
      (request) => request.route === "GET /search/issues",
    );
    expect(searchRequests).toHaveLength(2);
    expect(searchRequests.map((request) => request.options?.request)).toEqual([
      { signal: controller.signal },
      { signal: controller.signal },
    ]);
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
