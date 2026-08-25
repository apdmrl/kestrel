import { describe, expect, it } from "vitest";
import type { Credential, CredentialStore } from "../../ports/credential-store.js";
import { confirmLogout, logoutConfirmationToken, logoutGitHub } from "./logout-github.js";

class FakeCredentialStore implements CredentialStore {
  credential: Credential | undefined;
  readonly deleted: { service: string; account: string }[] = [];

  async get(): Promise<Credential | undefined> {
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
    await expect(
      logoutGitHub({ credentialStore }, { confirmation: undefined }),
    ).rejects.toMatchObject({
      userMessage: expect.stringContaining("github.com") as unknown as string,
    });
    const error = await logoutGitHub({ credentialStore }, { confirmation: undefined }).catch(
      (caught: unknown) => caught as { suggestedActions: readonly string[] },
    );
    expect(error.suggestedActions.join(" ")).toContain("--confirm github.com");
    expect(error.suggestedActions.join(" ").toLowerCase()).toContain("git");
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
});
