import { describe, expect, it } from "vitest";
import type {
  ProcessResult,
  ProcessRunner,
  RunProcessOptions,
} from "../../ports/process-runner.js";
import { GitCredentialStore } from "./git-credential-store.js";

class FakeRunner implements ProcessRunner {
  readonly calls: { args: string[]; input?: string }[] = [];

  async run(options: RunProcessOptions): Promise<ProcessResult> {
    this.calls.push({
      args: [...options.args],
      ...(options.input !== undefined ? { input: options.input } : {}),
    });
    if (options.args.includes("fill")) {
      return { exitCode: 0, stdout: "username=octocat\npassword=secret-token\n", stderr: "" };
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
    expect(runner.calls[0]?.args).toEqual(["credential", "approve"]);
    expect(runner.calls[0]?.input).toContain("password=secret-token");
  });

  it("rejects a credential via git credential reject", async () => {
    const runner = new FakeRunner();
    const store = new GitCredentialStore(runner);
    await store.delete("github", "octocat");
    expect(runner.calls[0]?.args).toEqual(["credential", "reject"]);
    expect(runner.calls[0]?.input).toContain("username=octocat");
  });
});
