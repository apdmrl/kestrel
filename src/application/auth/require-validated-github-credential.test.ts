import { describe, expect, it } from "vitest";
import { createKestrelError } from "../errors/kestrel-error.js";
import type { Credential, CredentialStore } from "../../ports/credential-store.js";
import type {
  DeviceFlowAuthorization,
  GitHubGateway,
  GitHubToken,
  GitHubViewer,
  IssueLinkResult,
  MergeInfo,
  PullRequestInfo,
} from "../../ports/github-gateway.js";
import { requireValidatedGitHubCredential } from "./require-validated-github-credential.js";

class FakeCredentialStore implements CredentialStore {
  credential: Credential | undefined;
  readonly stored: Credential[] = [];
  readonly deleted: string[] = [];
  capturedSignal: AbortSignal | undefined;

  async get(
    _service: string,
    _account: string,
    signal: AbortSignal,
  ): Promise<Credential | undefined> {
    this.capturedSignal = signal;
    return this.credential;
  }

  async store(credential: Credential, _signal: AbortSignal): Promise<void> {
    this.stored.push(credential);
    this.credential = credential;
  }

  async delete(_service: string, account: string, _signal: AbortSignal): Promise<void> {
    this.deleted.push(account);
    if (this.credential?.account === account) {
      this.credential = undefined;
    }
  }
}

class FakeGateway implements GitHubGateway {
  viewerCalls = 0;
  deviceFlowCalls = 0;
  pollForTokenCalls = 0;
  viewerFn: (token: string, signal?: AbortSignal) => GitHubViewer | Promise<GitHubViewer>;

  constructor() {
    this.viewerFn = () => {
      this.viewerCalls += 1;
      return { login: "ignored", id: 1 };
    };
  }

  async beginDeviceFlow(): Promise<DeviceFlowAuthorization> {
    this.deviceFlowCalls += 1;
    throw new Error("device flow must never be started by requireValidatedGitHubCredential");
  }

  async pollForToken(): Promise<GitHubToken> {
    this.pollForTokenCalls += 1;
    throw new Error("device flow must never be started by requireValidatedGitHubCredential");
  }

  async getViewer(token: string, signal?: AbortSignal): Promise<GitHubViewer> {
    return this.viewerFn(token, signal);
  }

  async getPullRequest(): Promise<PullRequestInfo> {
    throw new Error("unused");
  }

  async getIssueLinkage(): Promise<IssueLinkResult | undefined> {
    return undefined;
  }

  async getMergeInfo(): Promise<MergeInfo> {
    return { merged: false, mergeSha: undefined, mergedAt: undefined };
  }
}

describe("requireValidatedGitHubCredential", () => {
  it("fails closed without beginning device flow when no credential exists", async () => {
    const gateway = new FakeGateway();
    await expect(
      requireValidatedGitHubCredential(
        { credentialStore: new FakeCredentialStore(), gateway },
        { account: "github" },
      ),
    ).rejects.toMatchObject({ code: "DM_GITHUB_AUTH_REQUIRED" });
    expect(gateway.viewerCalls).toBe(0);
    expect(gateway.deviceFlowCalls).toBe(0);
    expect(gateway.pollForTokenCalls).toBe(0);
  });

  it("returns the live identity and token after validation", async () => {
    const store = new FakeCredentialStore();
    store.credential = { service: "github", account: "octocat", token: "cached-token" };
    const gateway = new FakeGateway();
    gateway.viewerFn = (token) => {
      expect(token).toBe("cached-token");
      return { login: "octocat", id: 42 };
    };
    const result = await requireValidatedGitHubCredential(
      { credentialStore: store, gateway },
      { account: "github" },
    );
    expect(result).toEqual({ token: "cached-token", login: "octocat" });
    expect(gateway.deviceFlowCalls).toBe(0);
  });

  it("propagates DM_GITHUB_AUTH_EXPIRED without starting device flow", async () => {
    const store = new FakeCredentialStore();
    store.credential = { service: "github", account: "octocat", token: "expired-token" };
    const gateway = new FakeGateway();
    gateway.viewerFn = () => {
      throw createKestrelError({
        code: "DM_GITHUB_AUTH_EXPIRED",
        category: "USER_ACTION_REQUIRED",
        userMessage: "token expired",
        suggestedActions: ["re-authenticate"],
        retryability: "NO_RETRY",
        recoveryStrategy: "REAUTHENTICATE",
        severity: "ERROR",
      });
    };
    await expect(
      requireValidatedGitHubCredential(
        { credentialStore: store, gateway },
        { account: "github" },
      ),
    ).rejects.toMatchObject({ code: "DM_GITHUB_AUTH_EXPIRED" });
    expect(gateway.deviceFlowCalls).toBe(0);
    expect(gateway.pollForTokenCalls).toBe(0);
  });

  it("does not demote network errors into auth errors", async () => {
    const store = new FakeCredentialStore();
    store.credential = { service: "github", account: "octocat", token: "cached-token" };
    const networkError = createKestrelError({
      code: "DM_GITHUB_TIMEOUT",
      category: "TRANSIENT",
      userMessage: "network unreachable",
      suggestedActions: ["retry"],
      retryability: "RETRYABLE",
      recoveryStrategy: "RETRY",
      severity: "WARNING",
    });
    const gateway = new FakeGateway();
    gateway.viewerFn = () => {
      throw networkError;
    };
    await expect(
      requireValidatedGitHubCredential(
        { credentialStore: store, gateway },
        { account: "github" },
      ),
    ).rejects.toMatchObject({ code: "DM_GITHUB_TIMEOUT" });
    expect(gateway.deviceFlowCalls).toBe(0);
  });

  it("passes the same signal into both the credential lookup and the viewer validation", async () => {
    const store = new FakeCredentialStore();
    store.credential = { service: "github", account: "octocat", token: "cached-token" };
    const gateway = new FakeGateway();
    const controller = new AbortController();
    let receivedViewerSignal: AbortSignal | undefined;
    gateway.viewerFn = (_token, signal) => {
      receivedViewerSignal = signal;
      return { login: "octocat", id: 1 };
    };
    await requireValidatedGitHubCredential(
      { credentialStore: store, gateway },
      { account: "github", signal: controller.signal },
    );
    expect(store.capturedSignal).toBe(controller.signal);
    expect(receivedViewerSignal).toBe(controller.signal);
  });
});