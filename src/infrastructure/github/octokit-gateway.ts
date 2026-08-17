import { createKestrelError } from "../../application/errors/kestrel-error.js";
import type {
  DeviceFlowAuthorization,
  GitHubGateway,
  GitHubToken,
  GitHubViewer,
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
    headers: Record<string, string>;
  }>;
}

export interface DeviceAuthStrategy {
  (options: { type: "oauth" }): Promise<{ token: string }>;
}

export interface DeviceAuthFactory {
  (options: {
    clientType: "oauth-app";
    clientId: string;
    scopes: string[];
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

export class OctokitGateway implements GitHubGateway {
  private pendingAuth: Promise<GitHubToken> | undefined;
  private strategy: DeviceAuthStrategy | undefined;

  constructor(
    private readonly octokit: OctokitLike,
    private readonly clientId: string,
    private readonly deviceAuthFactory: DeviceAuthFactory,
  ) {}

  async beginDeviceFlow(): Promise<DeviceFlowAuthorization> {
    let resolveVerification!: (value: DeviceFlowAuthorization) => void;
    const verificationPromise = new Promise<DeviceFlowAuthorization>((resolve) => {
      resolveVerification = resolve;
    });

    this.strategy = this.deviceAuthFactory({
      clientType: "oauth-app",
      clientId: this.clientId,
      scopes: ["public_repo"],
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

  async getViewer(token: string): Promise<GitHubViewer> {
    try {
      const response = await this.octokit.request("GET /user", {
        headers: { authorization: "Bearer " + token },
      });
      const data = response.data as { login: string; id: number };
      return { login: data.login, id: data.id };
    } catch (error) {
      throw mapGitHubError(error);
    }
  }
}
