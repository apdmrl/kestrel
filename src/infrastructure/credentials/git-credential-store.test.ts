import { describe, expect, it } from "vitest";
import type {
  ProcessResult,
  ProcessRunner,
  RunProcessOptions,
} from "../../ports/process-runner.js";
import { GitCredentialStore } from "./git-credential-store.js";

class FakeRunner implements ProcessRunner {
  readonly calls: { args: string[]; input?: string }[] = [];
  helperConfigured = true;

  async run(options: RunProcessOptions): Promise<ProcessResult> {
    this.calls.push({
      args: [...options.args],
      ...(options.input !== undefined ? { input: options.input } : {}),
    });
    if (options.args.includes("fill")) {
      return {
        exitCode: 0,
        stdout: this.helperConfigured ? "username=octocat\npassword=secret-token\n" : "",
        stderr: "",
      };
    }
    if (options.args[0] === "config") {
      return { exitCode: 0, stdout: this.helperConfigured ? "fake-helper\n" : "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

describe("GitCredentialStore", () => {
  it("fills a credential via git credential fill", async () => {
    const runner = new FakeRunner();
    const store = new GitCredentialStore(runner);
    const credential = await store.get("github", "octocat");
    expect(credential).toEqual({ service: "github", account: "octocat", token: "secret-token" });
    expect(runner.calls[0]?.args).toEqual(["credential", "fill"]);
    expect(runner.calls[0]?.input).toContain("host=github.com");
    expect(runner.calls[0]?.input).toContain("protocol=https");
  });

  it("approves a credential via git credential approve", async () => {
    const runner = new FakeRunner();
    const store = new GitCredentialStore(runner);
    await store.store({ service: "github", account: "octocat", token: "secret-token" });
    expect(runner.calls[0]?.args).toEqual(["config", "--get", "credential.helper"]);
    expect(runner.calls[1]?.args).toEqual(["credential", "approve"]);
    expect(runner.calls[1]?.input).toContain("password=secret-token");
  });

  it("rejects a credential via git credential reject", async () => {
    const runner = new FakeRunner();
    const store = new GitCredentialStore(runner);
    await store.delete("github", "octocat");
    expect(runner.calls[0]?.args).toEqual(["credential", "reject"]);
    expect(runner.calls[0]?.input).toContain("username=octocat");
  });

  it("raises USER_ACTION_REQUIRED when no credential helper is configured", async () => {
    const runner = new FakeRunner();
    runner.helperConfigured = false;
    const store = new GitCredentialStore(runner);
    await expect(store.get("github", "octocat")).rejects.toMatchObject({
      code: "DM_GITHUB_AUTH_REQUIRED",
      category: "USER_ACTION_REQUIRED",
    });
  });
});
