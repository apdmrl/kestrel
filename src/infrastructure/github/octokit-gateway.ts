import type { OAuthAppStrategyOptions } from "@octokit/auth-oauth-device";
import { createKestrelError } from "../../application/errors/kestrel-error.js";
import type { RepositoryIdentity } from "../../domain/challenge/repository-identity.js";
import type { IsoDateTime } from "../../domain/shared/time.js";
import type {
  DeviceFlowAuthorization,
  GitHubGateway,
  GitHubToken,
  GitHubViewer,
  IssueLinkResult,
  MergeInfo,
  PullRequestInfo,
} from "../../ports/github-gateway.js";
import { mapGitHubError } from "./github-error-mapper.js";

/** Minimal shape of Octokit's request method, kept narrow for testability. */
export interface OctokitLike {
  request(
    route: string,
    options?: Record<string, unknown>,
  ): Promise<{
    status: number;
    data: unknown;
    headers: Record<string, string | number | undefined>;
  }>;
}

export interface DeviceAuthStrategy {
  (options: { type: "oauth" }): Promise<{ token: string }>;
}

/**
 * The request implementation the device flow needs: the same shape the real
 * @octokit/auth-oauth-device strategy accepts, so the OAuth base URL is derived
 * from the configured API URL instead of defaulting to github.com.
 */
export type DeviceAuthRequest = NonNullable<OAuthAppStrategyOptions["request"]>;

export interface DeviceAuthFactory {
  (options: {
    clientType: "oauth-app";
    clientId: string;
    scopes: string[];
    /** Request implementation; without it the device flow bypasses GITHUB_API_URL. */
    request?: DeviceAuthRequest;
    onVerification: (verification: {
      device_code: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
    }) => void;
  }): DeviceAuthStrategy;
}

function cancelledError() {
  return createKestrelError({
    code: "DM_GITHUB_AUTH_CANCELLED",
    category: "USER_ACTION_REQUIRED",
    userMessage: "GitHub device flow was cancelled",
    suggestedActions: ["Run the command again when ready"],
    retryability: "NO_RETRY",
    recoveryStrategy: "USER_ACTION",
    severity: "INFO",
  });
}

function authRequiredError() {
  return createKestrelError({
    code: "DM_GITHUB_AUTH_REQUIRED",
    category: "USER_ACTION_REQUIRED",
    userMessage: "GitHub authentication is not configured",
    suggestedActions: ["Set GITHUB_CLIENT_ID and run the command again"],
    retryability: "NO_RETRY",
    recoveryStrategy: "USER_ACTION",
    severity: "ERROR",
  });
}

export class OctokitGateway implements GitHubGateway {
  private pendingAuth: Promise<GitHubToken> | undefined;
  private strategy: DeviceAuthStrategy | undefined;

  constructor(
    private readonly octokit: OctokitLike,
    private readonly clientId: string,
    private readonly deviceAuthFactory: DeviceAuthFactory,
  ) {}

  async beginDeviceFlow(): Promise<DeviceFlowAuthorization> {
    if (this.clientId.trim().length === 0) {
      throw authRequiredError();
    }
    let resolveVerification!: (value: DeviceFlowAuthorization) => void;
    const verificationPromise = new Promise<DeviceFlowAuthorization>((resolve) => {
      resolveVerification = resolve;
    });

    this.strategy = this.deviceAuthFactory({
      clientType: "oauth-app",
      clientId: this.clientId,
      scopes: ["public_repo"],
      // Route the device flow through the configured API base URL (production
      // api.github.com, or the local/test endpoint) instead of defaulting to
      // github.com and bypassing GITHUB_API_URL. The narrow OctokitLike view
      // hides endpoint metadata the device flow needs, so assert it here.
      request: this.octokit.request as DeviceAuthRequest,
      onVerification: (verification) => {
        resolveVerification({
          deviceCode: verification.device_code,
          userCode: verification.user_code,
          verificationUri: verification.verification_uri,
          expiresInSeconds: verification.expires_in,
          intervalSeconds: verification.interval,
        });
      },
    });

    this.pendingAuth = (async () => {
      const strategy = this.strategy;
      if (strategy === undefined) {
        throw cancelledError();
      }
      const authentication = await strategy({ type: "oauth" });
      const viewer = await this.getViewer(authentication.token);
      return { token: authentication.token, account: viewer.login };
    })().catch((error) => {
      throw mapGitHubError(error);
    });

    return verificationPromise;
  }

  async pollForToken(_deviceCode: string, signal?: AbortSignal): Promise<GitHubToken> {
    if (signal?.aborted === true) {
      throw cancelledError();
    }
    const pending = this.pendingAuth;
    if (pending === undefined) {
      throw cancelledError();
    }
    if (signal !== undefined) {
      const abort = new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(cancelledError()), { once: true });
      });
      return await Promise.race([pending, abort]);
    }
    return await pending;
  }

  async getViewer(token: string, signal?: AbortSignal): Promise<GitHubViewer> {
    try {
      const response = await this.octokit.request("GET /user", {
        headers: { authorization: "Bearer " + token },
        ...(signal !== undefined ? { request: { signal } } : {}),
      });
      const data = response.data as { login: string; id: number };
      return { login: data.login, id: data.id };
    } catch (error) {
      throw mapGitHubError(error, signal);
    }
  }

  async getPullRequest(
    repository: RepositoryIdentity,
    number: number,
    token: string,
    signal?: AbortSignal,
  ): Promise<PullRequestInfo> {
    try {
      const headers = { authorization: "Bearer " + token };
      const requestOptions = (): Record<string, unknown> => ({
        headers,
        ...(signal !== undefined ? { request: { signal } } : {}),
      });
      const prResponse = await this.octokit.request(
        "GET /repos/" + repository.owner + "/" + repository.name + "/pulls/" + number,
        requestOptions(),
      );
      const pr = prResponse.data as {
        number: number;
        html_url: string;
        user: { login: string };
        state: string;
      };
      const commitsResponse = await this.octokit.request(
        "GET /repos/" + repository.owner + "/" + repository.name + "/pulls/" + number + "/commits",
        requestOptions(),
      );
      const commitsData = commitsResponse.data as Array<{ sha: string }>;
      const state = pr.state === "open" ? "OPEN" : pr.state === "closed" ? "CLOSED" : "MERGED";
      return {
        number: pr.number,
        url: pr.html_url,
        repository,
        author: pr.user.login,
        commits: commitsData.map((commit) => commit.sha),
        state,
      };
    } catch (error) {
      throw mapGitHubError(error, signal);
    }
  }

  async getIssueLinkage(
    repository: RepositoryIdentity,
    prNumber: number,
    token: string,
    signal?: AbortSignal,
  ): Promise<IssueLinkResult | undefined> {
    try {
      const response = await this.octokit.request(
        "GET /repos/" + repository.owner + "/" + repository.name + "/pulls/" + prNumber,
        {
          headers: { authorization: "Bearer " + token },
          ...(signal !== undefined ? { request: { signal } } : {}),
        },
      );
      const pr = response.data as { body?: string | null };
      const body = pr.body ?? "";
      const match =
        /(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+#(\d+)/i.exec(body);
      if (match === null) {
        return undefined;
      }
      return {
        issueNumber: Number(match[1]),
        repository,
        relationship: "CLOSING_KEYWORD",
      };
    } catch (error) {
      throw mapGitHubError(error, signal);
    }
  }

  async getMergeInfo(
    repository: RepositoryIdentity,
    prNumber: number,
    token: string,
    signal?: AbortSignal,
  ): Promise<MergeInfo> {
    try {
      const response = await this.octokit.request(
        "GET /repos/" + repository.owner + "/" + repository.name + "/pulls/" + prNumber,
        {
          headers: { authorization: "Bearer " + token },
          ...(signal !== undefined ? { request: { signal } } : {}),
        },
      );
      const pr = response.data as {
        merged: boolean;
        merge_commit_sha?: string | null;
        merged_at?: string | null;
      };
      return {
        merged: pr.merged,
        mergeSha: pr.merge_commit_sha ?? undefined,
        mergedAt:
          pr.merged_at === null || pr.merged_at === undefined
            ? undefined
            : (pr.merged_at as IsoDateTime),
      };
    } catch (error) {
      throw mapGitHubError(error, signal);
    }
  }
}
