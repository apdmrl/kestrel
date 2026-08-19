import { createEvaluationContext } from "../../domain/challenge/evaluation-context.js";
import type { Challenge } from "../../domain/challenge/challenge.js";
import type { EvaluationContext } from "../../domain/challenge/evaluation-context.js";
import type { RepositoryIdentity } from "../../domain/challenge/repository-identity.js";
import type { SearchIntent } from "../../domain/discovery/search-intent.js";
import type { Clock } from "../../ports/clock.js";
import type { IdGenerator } from "../../ports/id-generator.js";
import type { ChallengeSource } from "../../ports/challenge-source.js";
import { planDiscovery } from "../../application/discovery/discovery-planner.js";
import { normalizeIssue } from "./github-normalizer.js";
import { mapGitHubError } from "./github-error-mapper.js";
import type { OctokitLike } from "./octokit-gateway.js";

function buildQuery(query: {
  labels: readonly string[];
  topics: readonly string[];
  language: string | undefined;
  missionType: string;
}): string {
  const parts = ["is:issue", "state:open"];
  if (query.language !== undefined) {
    parts.push("language:" + query.language);
  }
  for (const label of query.labels) {
    parts.push("label:" + label);
  }
  for (const topic of query.topics) {
    parts.push("topic:" + topic);
  }
  return parts.join(" ");
}

function normalizeStars(stars: number | undefined): number | undefined {
  if (stars === undefined || stars < 0) {
    return undefined;
  }
  return Math.min(1, Math.log10(stars + 1) / 6);
}

export class GithubChallengeSource implements ChallengeSource {
  constructor(
    private readonly octokit: OctokitLike,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  async search(intent: SearchIntent, signal?: AbortSignal): Promise<readonly Challenge[]> {
    const plan = planDiscovery(intent);
    const batch = plan.batches[0];
    if (batch === undefined) {
      return [];
    }
    const q = buildQuery(batch.query);
    let response;
    try {
      response = await this.octokit.request("GET /search/issues", {
        q,
        per_page: batch.pageBudget,
        page: 1,
        ...(signal !== undefined ? { request: { signal } } : {}),
      });
    } catch (error) {
      throw mapGitHubError(error, signal);
    }
    const data = response.data as { items?: Array<Record<string, unknown>> };
    const challenges: Challenge[] = [];
    for (const raw of data.items ?? []) {
      const repository = this.repositoryFromRaw(raw);
      if (repository === undefined) {
        continue;
      }
      const issue = raw as {
        id: number;
        number: number;
        title: string;
        state: string;
        labels?: { name?: string }[];
        pull_request?: unknown;
        html_url?: string;
        body?: string | null;
        created_at: string;
        updated_at: string;
      };
      const normalized = normalizeIssue({
        issue,
        repository,
        issueId: this.idGenerator.newChallengeId(),
      });
      if (normalized.kind === "challenge") {
        challenges.push(normalized.challenge);
      }
    }
    return challenges;
  }

  async enrich(challenge: Challenge, signal?: AbortSignal): Promise<EvaluationContext> {
    let repo;
    try {
      repo = await this.octokit.request(
        "GET /repos/" + challenge.repository.owner + "/" + challenge.repository.name,
        ...(signal !== undefined ? [{ request: { signal } }] : []),
      );
    } catch (error) {
      throw mapGitHubError(error, signal);
    }
    const data = repo.data as {
      archived?: boolean;
      stargazers_count?: number;
      open_issues_count?: number;
    };
    const interest = normalizeStars(data.stargazers_count);
    const result = createEvaluationContext({
      observedAt: this.clock.now(),
      repositoryHealth: data.archived === true ? 0 : 1,
      ...(interest !== undefined ? { repositoryInterest: interest } : {}),
      ...(data.open_issues_count !== undefined ? { competingWork: data.open_issues_count } : {}),
      confidence: 0.6,
    });
    if (result.ok) {
      return result.value;
    }
    // Unreachable: the inputs above are always within validated bounds.
    return {
      observedAt: this.clock.now(),
      repositoryHealth: 0,
      repositoryInterest: undefined,
      contributionGuide: undefined,
      competingWork: undefined,
      maintainerActivity: undefined,
      issueQuality: undefined,
      confidence: 1,
    };
  }

  private repositoryFromRaw(raw: Record<string, unknown>): RepositoryIdentity | undefined {
    const repositoryUrl = raw.repository_url;
    if (typeof repositoryUrl !== "string") {
      return undefined;
    }
    const match = /github\.com\/repos\/([^/]+)\/([^/]+)$/.exec(repositoryUrl);
    if (match === null) {
      return undefined;
    }
    return { provider: "github", owner: match[1] as string, name: match[2] as string };
  }
}
