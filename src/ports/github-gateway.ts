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

/** Provider-neutral GitHub API boundary (device flow, identity, and verification). */
export interface GitHubGateway {
  beginDeviceFlow(): Promise<DeviceFlowAuthorization>;
  pollForToken(deviceCode: string, signal?: AbortSignal): Promise<GitHubToken>;
  getViewer(token: string): Promise<GitHubViewer>;
}
