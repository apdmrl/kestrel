import type { RepositoryIdentity } from "../domain/challenge/repository-identity.js";
import type { IsoDateTime } from "../domain/shared/time.js";

export interface DeviceFlowAuthorization {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresInSeconds: number;
  readonly intervalSeconds: number;
}

export interface GitHubToken {
  readonly token: string;
  readonly account: string;
}

export interface GitHubViewer {
  readonly login: string;
  readonly id: number;
}

export interface PullRequestInfo {
  readonly number: number;
  readonly url: string;
  readonly repository: RepositoryIdentity;
  readonly author: string;
  readonly commits: readonly string[];
  readonly state: "OPEN" | "MERGED" | "CLOSED";
}

export interface IssueLinkResult {
  readonly issueNumber: number;
  readonly repository: RepositoryIdentity;
  readonly relationship: "CLOSING_KEYWORD" | "CROSS_REFERENCE" | "PROVIDER_VERIFIED";
}

export interface MergeInfo {
  readonly merged: boolean;
  readonly mergeSha: string | undefined;
  readonly mergedAt: IsoDateTime | undefined;
}

/** Provider-neutral GitHub API boundary (device flow, identity, and verification). */
export interface GitHubGateway {
  beginDeviceFlow(): Promise<DeviceFlowAuthorization>;
  pollForToken(deviceCode: string, signal?: AbortSignal): Promise<GitHubToken>;
  getViewer(token: string): Promise<GitHubViewer>;
  getPullRequest(
    repository: RepositoryIdentity,
    number: number,
    token: string,
  ): Promise<PullRequestInfo>;
  getIssueLinkage(
    repository: RepositoryIdentity,
    prNumber: number,
    token: string,
  ): Promise<IssueLinkResult | undefined>;
  getMergeInfo(repository: RepositoryIdentity, prNumber: number, token: string): Promise<MergeInfo>;
}
