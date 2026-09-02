import { describe, expect, it } from "vitest";
import type {
  ProcessResult,
  ProcessRunner,
  RunProcessOptions,
} from "../../ports/process-runner.js";
import { GitCredentialStore } from "./git-credential-store.js";

class FakeRunner implements ProcessRunner {
  readonly calls: { args: string[]; input?: string; signal?: AbortSignal }[] = [];
  helperConfigured = true;

  async run(options: RunProcessOptions): Promise<ProcessResult> {
    this.calls.push({
      args: [...options.args],
      ...(options.input !== undefined ? { input: options.input } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
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
    const credential = await store.get("github", "octocat", new AbortController().signal);
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
    await expect(
      store.get("github", "octocat", new AbortController().signal),
    ).rejects.toMatchObject({
      code: "DM_GITHUB_AUTH_REQUIRED",
      category: "USER_ACTION_REQUIRED",
    });
  });

  it("forwards the AbortSignal into git credential fill so SIGTERM cancels a hung helper", async () => {
    const runner = new FakeRunner();
    const store = new GitCredentialStore(runner);
    const controller = new AbortController();
    await store.get("github", "octocat", controller.signal);
    // The startup auth check forwards its context signal into the
    // `git credential fill` subprocess so a hung helper exits when
    // the parent tears down — the execa runner wires options.signal
    // into the cancelSignal that triggers SIGTERM.
    expect(runner.calls[0]?.signal).toBe(controller.signal);
  });

  it("forwards the AbortSignal into the helper-detection subprocess when fill returns no credentials", async () => {
    const runner = new FakeRunner();
    runner.helperConfigured = false;
    const store = new GitCredentialStore(runner);
    const controller = new AbortController();
    // Causal assertion: the same AbortSignal that reaches `credential fill`
    // also reaches the follow-up `git config --get credential.helper`
    // subprocess. Otherwise a hung `credential fill` could exit because of
    // the signal but the helper-detection call could outlive the parent.
    await expect(store.get("github", "octocat", controller.signal)).rejects.toMatchObject({
      code: "DM_GITHUB_AUTH_REQUIRED",
    });
    const fillCall = runner.calls.find((call) => call.args.includes("fill"));
    const helperCall = runner.calls.find(
      (call) => call.args[0] === "config" && call.args[1] === "--get",
    );
    expect(fillCall?.signal).toBe(controller.signal);
    expect(helperCall?.signal).toBe(controller.signal);
  });
});
