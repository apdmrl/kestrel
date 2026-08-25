import { describe, expect, it } from "vitest";
import type { Credential, CredentialStore } from "../../ports/credential-store.js";
import type { GitHubGateway, GitHubViewer } from "../../ports/github-gateway.js";
import { createKestrelError } from "../errors/kestrel-error.js";
import { getAuthStatus } from "./get-auth-status.js";

class FakeCredentialStore implements CredentialStore {
  credential: Credential | undefined;
  readonly deleted: string[] = [];
  readonly stored: Credential[] = [];

  async get(): Promise<Credential | undefined> {
    return this.credential;
  }

  async store(credential: Credential): Promise<void> {
    this.stored.push(credential);
    this.credential = credential;
  }

  async delete(_service: string, account: string): Promise<void> {
    this.deleted.push(account);
    this.credential = undefined;
  }
}

class FakeGateway implements GitHubGateway {
  viewerFn: (token: string, signal?: AbortSignal) => GitHubViewer | Promise<GitHubViewer> = () => {
    throw new Error("unexpected getViewer");
  };
  capturedSignal: AbortSignal | undefined;
  viewerCalls = 0;

  async beginDeviceFlow(): Promise<never> {
    throw new Error("device flow must not start while reading status");
  }

  async pollForToken(): Promise<never> {
    throw new Error("polling must not start while reading status");
  }

  async getViewer(token: string, signal?: AbortSignal): Promise<GitHubViewer> {
    this.viewerCalls += 1;
    this.capturedSignal = signal;
    return this.viewerFn(token, signal);
  }

  async getPullRequest(): Promise<never> {
    throw new Error("unused");
  }

  async getIssueLinkage(): Promise<undefined> {
    return undefined;
  }

  async getMergeInfo(): Promise<never> {
    throw new Error("unused");
  }
}

function expiredError() {
  return createKestrelError({
    code: "DM_GITHUB_AUTH_EXPIRED",
    category: "USER_ACTION_REQUIRED",
    userMessage: "GitHub authentication has expired",
    suggestedActions: ["Re-run the command to re-authenticate"],
    retryability: "NO_RETRY",
    recoveryStrategy: "REAUTHENTICATE",
    severity: "ERROR",
  });
}

describe("getAuthStatus", () => {
  it("reports NOT_CONNECTED when no credential is stored", async () => {
    const credentialStore = new FakeCredentialStore();
    const gateway = new FakeGateway();
    const status = await getAuthStatus({ credentialStore, gateway }, { account: "github" });
    expect(status).toEqual({ connected: false, login: null, detail: "NOT_CONNECTED" });
    expect(gateway.viewerCalls).toBe(0);
  });

  it("reports CONNECTED with the login validated against GitHub", async () => {
    const credentialStore = new FakeCredentialStore();
    credentialStore.credential = { service: "github", account: "octocat", token: "live-token" };
    const gateway = new FakeGateway();
    const seen: string[] = [];
    gateway.viewerFn = (token) => {
      seen.push(token);
      return { login: "octocat", id: 1 };
    };
    const status = await getAuthStatus({ credentialStore, gateway }, { account: "github" });
    expect(status).toEqual({ connected: true, login: "octocat", detail: "CONNECTED" });
    expect(seen).toEqual(["live-token"]);
  });

  it("reports the live login even when it differs from the stored account key", async () => {
    const credentialStore = new FakeCredentialStore();
    credentialStore.credential = { service: "github", account: "github", token: "live-token" };
    const gateway = new FakeGateway();
    gateway.viewerFn = () => ({ login: "hubot", id: 2 });
    const status = await getAuthStatus({ credentialStore, gateway }, { account: "github" });
    expect(status).toEqual({ connected: true, login: "hubot", detail: "CONNECTED" });
  });

  it("reports EXPIRED when GitHub rejects the stored token", async () => {
    const credentialStore = new FakeCredentialStore();
    credentialStore.credential = { service: "github", account: "octocat", token: "stale-token" };
    const gateway = new FakeGateway();
    gateway.viewerFn = () => {
      throw expiredError();
    };
    const status = await getAuthStatus({ credentialStore, gateway }, { account: "github" });
    expect(status).toEqual({ connected: false, login: null, detail: "EXPIRED" });
  });

  it("leaves the expired credential in place, because reading status must not mutate", async () => {
    const credentialStore = new FakeCredentialStore();
    credentialStore.credential = { service: "github", account: "octocat", token: "stale-token" };
    const gateway = new FakeGateway();
    gateway.viewerFn = () => {
      throw expiredError();
    };
    await getAuthStatus({ credentialStore, gateway }, { account: "github" });
    expect(credentialStore.deleted).toEqual([]);
    expect(credentialStore.credential).toEqual({
      service: "github",
      account: "octocat",
      token: "stale-token",
    });
  });

  it("propagates an unrelated gateway failure instead of reporting not connected", async () => {
    const credentialStore = new FakeCredentialStore();
    credentialStore.credential = { service: "github", account: "octocat", token: "live-token" };
    const gateway = new FakeGateway();
    gateway.viewerFn = () => {
      throw createKestrelError({
        code: "DM_NETWORK_UNAVAILABLE",
        category: "TRANSIENT",
        userMessage: "The network is unavailable",
        suggestedActions: ["Check your connection and retry"],
        retryability: "RETRYABLE",
        recoveryStrategy: "RETRY",
        severity: "ERROR",
      });
    };
    await expect(
      getAuthStatus({ credentialStore, gateway }, { account: "github" }),
    ).rejects.toMatchObject({ code: "DM_NETWORK_UNAVAILABLE" });
  });

  it("forwards the cancellation signal to the gateway", async () => {
    const credentialStore = new FakeCredentialStore();
    credentialStore.credential = { service: "github", account: "octocat", token: "live-token" };
    const gateway = new FakeGateway();
    gateway.viewerFn = () => ({ login: "octocat", id: 1 });
    const controller = new AbortController();
    await getAuthStatus(
      { credentialStore, gateway },
      { account: "github", signal: controller.signal },
    );
    expect(gateway.capturedSignal).toBe(controller.signal);
  });

  it("never exposes the stored token in its result", async () => {
    const credentialStore = new FakeCredentialStore();
    credentialStore.credential = { service: "github", account: "octocat", token: "secret-token" };
    const gateway = new FakeGateway();
    gateway.viewerFn = () => ({ login: "octocat", id: 1 });
    const status = await getAuthStatus({ credentialStore, gateway }, { account: "github" });
    expect(JSON.stringify(status)).not.toContain("secret-token");
  });
});
