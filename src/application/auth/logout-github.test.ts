import { describe, expect, it } from "vitest";
import type { Credential, CredentialStore } from "../../ports/credential-store.js";
import { isKestrelError } from "../errors/kestrel-error.js";
import { confirmLogout, logoutConfirmationToken, logoutGitHub } from "./logout-github.js";

class FakeCredentialStore implements CredentialStore {
  credential: Credential | undefined;
  readonly deleted: { service: string; account: string }[] = [];
  /** Every signal the store saw across `get` calls, including the
   * never-aborted sentinel when the caller did not pass one. */
  readonly getSignals: AbortSignal[] = [];

  async get(
    _service: string,
    _account: string,
    signal: AbortSignal,
  ): Promise<Credential | undefined> {
    this.getSignals.push(signal);
    return this.credential;
  }

  async store(credential: Credential): Promise<void> {
    this.credential = credential;
  }

  async delete(service: string, account: string): Promise<void> {
    this.deleted.push({ service, account });
    this.credential = undefined;
  }
}

// Hardcoded rather than derived from logoutConfirmationToken(): feeding the
// function's own output back in would make every test below pass even if the
// token changed, which is exactly the regression these tests must catch.
const token = "github.com";

describe("logoutConfirmationToken", () => {
  it("is the host whose credential will be cleared, so it is self-documenting", () => {
    expect(logoutConfirmationToken()).toBe(token);
  });

  it("confirms only an exact match", () => {
    expect(confirmLogout("github.com")).toBe(true);
    expect(confirmLogout("GitHub.com")).toBe(false);
    expect(confirmLogout("github")).toBe(false);
    expect(confirmLogout("")).toBe(false);
    expect(confirmLogout(" github.com ")).toBe(false);
  });
});

describe("logoutGitHub", () => {
  it("deletes the stored credential when the confirmation matches", async () => {
    const credentialStore = new FakeCredentialStore();
    credentialStore.credential = { service: "github", account: "octocat", token: "secret-token" };
    const result = await logoutGitHub({ credentialStore }, { confirmation: token });
    expect(result).toEqual({ connected: false, login: null, detail: "LOGGED_OUT" });
    expect(credentialStore.deleted).toEqual([{ service: "github", account: "octocat" }]);
    expect(credentialStore.credential).toBeUndefined();
  });

  it("refuses without a confirmation and deletes nothing", async () => {
    const credentialStore = new FakeCredentialStore();
    credentialStore.credential = { service: "github", account: "octocat", token: "secret-token" };
    await expect(
      logoutGitHub({ credentialStore }, { confirmation: undefined }),
    ).rejects.toMatchObject({ category: "INVALID_INPUT" });
    expect(credentialStore.deleted).toEqual([]);
    expect(credentialStore.credential).not.toBeUndefined();
  });

  it("refuses a wrong confirmation and deletes nothing", async () => {
    const credentialStore = new FakeCredentialStore();
    credentialStore.credential = { service: "github", account: "octocat", token: "secret-token" };
    await expect(logoutGitHub({ credentialStore }, { confirmation: "yes" })).rejects.toMatchObject({
      category: "INVALID_INPUT",
    });
    expect(credentialStore.deleted).toEqual([]);
  });

  it("names the required token and the shared-credential consequence when refusing", async () => {
    const credentialStore = new FakeCredentialStore();
    const caught: unknown = await logoutGitHub(
      { credentialStore },
      { confirmation: undefined },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    if (!isKestrelError(caught)) {
      throw new Error("expected a classified KestrelError");
    }
    expect(caught.userMessage).toContain("github.com");
    expect(caught.suggestedActions.join(" ")).toContain("--confirm github.com");
    expect(caught.userMessage.toLowerCase()).toContain("git");
  });

  it("is idempotent when nothing is stored", async () => {
    const credentialStore = new FakeCredentialStore();
    const result = await logoutGitHub({ credentialStore }, { confirmation: token });
    expect(result).toEqual({ connected: false, login: null, detail: "LOGGED_OUT" });
    expect(credentialStore.deleted).toEqual([]);
  });

  it("never exposes the cleared token in its result", async () => {
    const credentialStore = new FakeCredentialStore();
    credentialStore.credential = { service: "github", account: "octocat", token: "secret-token" };
    const result = await logoutGitHub({ credentialStore }, { confirmation: token });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("forwards the caller's cancellation signal into the credential lookup", async () => {
    const credentialStore = new FakeCredentialStore();
    credentialStore.credential = { service: "github", account: "octocat", token: "cached-token" };
    const controller = new AbortController();
    await logoutGitHub(
      { credentialStore },
      { confirmation: token, signal: controller.signal },
    );
    expect(credentialStore.getSignals).toEqual([controller.signal]);
    expect(credentialStore.deleted).toEqual([{ service: "github", account: "octocat" }]);
  });

  it("propagates an aborted lookup signal as a DM_PROCESS_CANCELLED error before any deletion", async () => {
    const credentialStore = new FakeCredentialStore();
    let receivedSignal: AbortSignal | undefined;
    credentialStore.get = async (
      _service: string,
      _account: string,
      signal: AbortSignal,
    ) => {
      receivedSignal = signal;
      if (signal.aborted === true) {
        throw Object.assign(new Error("lookup aborted"), {
          code: "DM_PROCESS_CANCELLED",
          name: "KestrelError",
          category: "USER_ACTION_REQUIRED",
          userMessage: "credential lookup cancelled",
          suggestedActions: ["retry"],
          retryability: "NO_RETRY",
          recoveryStrategy: "USER_ACTION",
          severity: "INFO",
        });
      }
      return credentialStore.credential;
    };
    const controller = new AbortController();
    controller.abort();
    await expect(
      logoutGitHub(
        { credentialStore },
        { confirmation: token, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "DM_PROCESS_CANCELLED" });
    expect(receivedSignal).toBe(controller.signal);
    expect(credentialStore.deleted).toEqual([]);
  });

  it("supplies a never-aborted signal when the caller did not pass one", async () => {
    const credentialStore = new FakeCredentialStore();
    credentialStore.credential = { service: "github", account: "octocat", token: "cached-token" };
    await logoutGitHub({ credentialStore }, { confirmation: token });
    expect(credentialStore.getSignals).toHaveLength(1);
    const lookupSignal = credentialStore.getSignals[0];
    expect(lookupSignal?.aborted).toBe(false);
    expect(credentialStore.deleted).toEqual([{ service: "github", account: "octocat" }]);
  });
});
