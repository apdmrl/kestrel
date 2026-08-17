import { describe, expect, it } from "vitest";
import type { Credential, CredentialStore } from "../../ports/credential-store.js";
import type {
  DeviceFlowAuthorization,
  GitHubGateway,
  GitHubToken,
  GitHubViewer,
} from "../../ports/github-gateway.js";
import { createKestrelError } from "../errors/kestrel-error.js";
import { authenticateGitHub } from "./authenticate-github.js";

const authorization: DeviceFlowAuthorization = {
  deviceCode: "device-code",
  userCode: "ABCD",
  verificationUri: "https://github.com/login/device",
  expiresInSeconds: 900,
  intervalSeconds: 5,
};

class FakeCredentialStore implements CredentialStore {
  readonly creds = new Map<string, Credential>();
  readonly deleted: string[] = [];
  readonly stored: Credential[] = [];

  async get(service: string, account: string): Promise<Credential | undefined> {
    return this.creds.get(service + ":" + account);
  }

  async store(credential: Credential): Promise<void> {
    this.stored.push(credential);
    this.creds.set(credential.service + ":" + credential.account, credential);
  }

  async delete(service: string, account: string): Promise<void> {
    this.deleted.push(account);
    this.creds.delete(service + ":" + account);
  }
}

/** Models the GitCredentialStore behavior: a single stored credential returned
 *  regardless of the lookup account. */
class AccountInsensitiveStore implements CredentialStore {
  private credential: Credential | undefined;
  readonly deleted: string[] = [];
  readonly stored: Credential[] = [];

  set(credential: Credential): void {
    this.credential = credential;
  }

  async get(): Promise<Credential | undefined> {
    return this.credential;
  }

  async store(credential: Credential): Promise<void> {
    this.stored.push(credential);
    this.credential = credential;
  }

  async delete(_service: string, account: string): Promise<void> {
    this.deleted.push(account);
    if (this.credential?.account === account) {
      this.credential = undefined;
    }
  }
}

class FakeGateway implements GitHubGateway {
  viewerFn: (token: string) => GitHubViewer = () => {
    throw new Error("unexpected getViewer");
  };
  pollFn: (signal?: AbortSignal) => GitHubToken = () => ({
    token: "new-token",
    account: "octocat",
  });
  deviceFlowCalls = 0;

  async beginDeviceFlow(): Promise<DeviceFlowAuthorization> {
    this.deviceFlowCalls += 1;
    return authorization;
  }

  async pollForToken(_deviceCode: string, signal?: AbortSignal): Promise<GitHubToken> {
    return this.pollFn(signal);
  }

  async getViewer(token: string): Promise<GitHubViewer> {
    return this.viewerFn(token);
  }

  async getPullRequest(): Promise<never> {
    throw new Error("unused");
  }

  async getIssueLinkage(): Promise<undefined> {
    return undefined;
  }

  async getMergeInfo(): Promise<{ merged: boolean; mergeSha: undefined; mergedAt: undefined }> {
    return { merged: false, mergeSha: undefined, mergedAt: undefined };
  }
}

function deps(store: CredentialStore, gateway: FakeGateway) {
  return { credentialStore: store, gateway };
}

describe("authenticateGitHub", () => {
  it("reuses a cached valid token without starting device flow", async () => {
    const store = new FakeCredentialStore();
    store.creds.set("github:octocat", { service: "github", account: "octocat", token: "cached" });
    const gateway = new FakeGateway();
    gateway.viewerFn = (token) => {
      expect(token).toBe("cached");
      return { login: "octocat", id: 1 };
    };

    const result = await authenticateGitHub(deps(store, gateway), { account: "octocat" });
    expect(result.token).toBe("cached");
    expect(gateway.deviceFlowCalls).toBe(0);
  });

  it("removes an expired cached token and re-authenticates", async () => {
    const store = new FakeCredentialStore();
    store.creds.set("github:octocat", { service: "github", account: "octocat", token: "expired" });
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

    const result = await authenticateGitHub(deps(store, gateway), { account: "octocat" });
    expect(store.deleted).toContain("octocat");
    expect(gateway.deviceFlowCalls).toBe(1);
    expect(result.token).toBe("new-token");
  });

  it("completes the device flow and stores the token", async () => {
    const store = new FakeCredentialStore();
    const gateway = new FakeGateway();
    const result = await authenticateGitHub(deps(store, gateway), { account: "octocat" });
    expect(gateway.deviceFlowCalls).toBe(1);
    expect(store.stored).toHaveLength(1);
    expect(store.stored[0]?.token).toBe("new-token");
    expect(result.token).toBe("new-token");
  });

  it("propagates a device-flow cancellation", async () => {
    const store = new FakeCredentialStore();
    const gateway = new FakeGateway();
    gateway.pollFn = () => {
      throw createKestrelError({
        code: "DM_GITHUB_AUTH_CANCELLED",
        category: "USER_ACTION_REQUIRED",
        userMessage: "device flow cancelled",
        suggestedActions: ["retry"],
        retryability: "NO_RETRY",
        recoveryStrategy: "USER_ACTION",
        severity: "INFO",
      });
    };
    await expect(
      authenticateGitHub(deps(store, gateway), { account: "octocat" }),
    ).rejects.toMatchObject({ code: "DM_GITHUB_AUTH_CANCELLED" });
  });

  it("never leaks the token in a failure", async () => {
    const store = new FakeCredentialStore();
    const gateway = new FakeGateway();
    gateway.pollFn = () => {
      throw new Error("device flow failed");
    };
    let message = "";
    try {
      await authenticateGitHub(deps(store, gateway), { account: "octocat" });
    } catch (error) {
      message = JSON.stringify(error);
    }
    expect(message).not.toContain("new-token");
  });

  it("presents the verification URI and user code in interactive mode", async () => {
    const store = new FakeCredentialStore();
    const gateway = new FakeGateway();
    const presented: DeviceFlowAuthorization[] = [];
    const result = await authenticateGitHub(deps(store, gateway), {
      account: "octocat",
      onAuthorization: (auth) => {
        presented.push(auth);
      },
    });
    expect(gateway.deviceFlowCalls).toBe(1);
    expect(presented).toHaveLength(1);
    expect(presented[0]?.verificationUri).toBe("https://github.com/login/device");
    expect(presented[0]?.userCode).toBe("ABCD");
    expect(result.token).toBe("new-token");
  });

  it("fails immediately in non-interactive mode without starting device flow", async () => {
    const store = new FakeCredentialStore();
    const gateway = new FakeGateway();
    await expect(
      authenticateGitHub(deps(store, gateway), { account: "octocat", interactive: false }),
    ).rejects.toMatchObject({ code: "DM_GITHUB_AUTH_REQUIRED" });
    expect(gateway.deviceFlowCalls).toBe(0);
  });

  it("reuses a cached token under the stored account regardless of the lookup key", async () => {
    const store = new AccountInsensitiveStore();
    store.set({ service: "github", account: "octocat", token: "cached" });
    const gateway = new FakeGateway();
    gateway.viewerFn = (token) => {
      expect(token).toBe("cached");
      return { login: "octocat", id: 1 };
    };
    const result = await authenticateGitHub(deps(store, gateway), { account: "github" });
    expect(result).toEqual({ account: "octocat", token: "cached" });
    expect(gateway.deviceFlowCalls).toBe(0);
  });

  it("stores the replacement token under the viewer's account identity", async () => {
    const store = new FakeCredentialStore();
    store.creds.set("github:octocat", { service: "github", account: "octocat", token: "expired" });
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
    gateway.pollFn = () => ({ token: "fresh-token", account: "octocat" });
    const result = await authenticateGitHub(deps(store, gateway), { account: "octocat" });
    expect(store.deleted).toContain("octocat");
    expect(result).toEqual({ account: "octocat", token: "fresh-token" });
    expect(store.stored).toEqual([{ service: "github", account: "octocat", token: "fresh-token" }]);
  });
});
