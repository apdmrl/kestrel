import { describe, expect, it } from "vitest";
import type {
  ProcessResult,
  ProcessRunner,
  RunProcessOptions,
} from "../../ports/process-runner.js";
import { GitCredentialStore } from "./git-credential-store.js";
type RunPredicate = (args: readonly string[]) => boolean;

class FakeRunner implements ProcessRunner {
  readonly calls: { args: string[]; input?: string; signal?: AbortSignal }[] = [];
  helperConfigured = true;
  /** Optional per-command matcher: when present, run() returns a promise
   * that rejects only when the supplied signal aborts. Used to model a
   * real subprocess whose parent can cancel it via SIGTERM. */
  hangMatcher: RunPredicate | undefined;

  async run(options: RunProcessOptions): Promise<ProcessResult> {
    this.calls.push({
      args: [...options.args],
      ...(options.input !== undefined ? { input: options.input } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    if (this.hangMatcher !== undefined && this.hangMatcher(options.args)) {
      // When the production code fails to forward a signal into the
      // hung subprocess, reject loudly. The test will observe this
      // rejection as a DM_PROCESS_CANCELLED-mismatch and fail; the
      // missing-signal is the regression we are pinning.
      const signal = options.signal;
      if (signal === undefined) {
        throw new Error(
          "hung subprocess received no AbortSignal - production code did not forward one",
        );
      }
      return new Promise<ProcessResult>((_resolve, reject) => {
        if (signal.aborted) {
          reject(
            Object.assign(new Error("subprocess aborted"), {
              code: "DM_PROCESS_CANCELLED",
            }),
          );
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            reject(
              Object.assign(new Error("subprocess aborted"), {
                code: "DM_PROCESS_CANCELLED",
              }),
            );
          },
          { once: true },
        );
      });
    }
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
    const controller = new AbortController();
    await store.store(
      { service: "github", account: "octocat", token: "secret-token" },
      controller.signal,
    );
    expect(runner.calls[0]?.args).toEqual(["config", "--get", "credential.helper"]);
    expect(runner.calls[1]?.args).toEqual(["credential", "approve"]);
    expect(runner.calls[1]?.input).toContain("password=secret-token");
    expect(runner.calls[1]?.signal).toBe(controller.signal);
  });

  it("rejects a credential via git credential reject", async () => {
    const runner = new FakeRunner();
    const store = new GitCredentialStore(runner);
    const controller = new AbortController();
    await store.delete("github", "octocat", controller.signal);
    expect(runner.calls[0]?.args).toEqual(["credential", "reject"]);
    expect(runner.calls[0]?.input).toContain("username=octocat");
    expect(runner.calls[0]?.signal).toBe(controller.signal);
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
  it("cancels a hung `git config --get credential.helper` helper-detection subprocess inside store via the caller's AbortSignal", async () => {
    const runner = new FakeRunner();
    runner.hangMatcher = (args) =>
      args[0] === "config" && args[1] === "--get" && args[2] === "credential.helper";
    const store = new GitCredentialStore(runner);
    const controller = new AbortController();
    // `store` calls `requireHelper` before invoking `credential approve`.
    // The same AbortSignal that reaches `store` must reach that helper
    // detection call so a hung helper exits when the parent aborts —
    // pinned here so a future regression that routes a separate
    // never-aborted signal would fail this test.
    const promise = store.store(
      { service: "github", account: "octocat", token: "secret-token" },
      controller.signal,
    );
    await Promise.resolve();
    const helperCall = runner.calls.find(
      (call) => call.args[0] === "config" && call.args[1] === "--get",
    );
    expect(helperCall?.signal).toBe(controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: "DM_PROCESS_CANCELLED" });
  });

  it("cancels a hung `git credential approve` subprocess via the caller's AbortSignal", async () => {
    const runner = new FakeRunner();
    runner.hangMatcher = (args) => args[0] === "credential" && args[1] === "approve";
    const store = new GitCredentialStore(runner);
    const controller = new AbortController();
    // `requireHelper` resolves (a helper is configured), so the store
    // reaches the `git credential approve` subprocess and waits there.
    const promise = store.store(
      { service: "github", account: "octocat", token: "secret-token" },
      controller.signal,
    );
    await Promise.resolve();
    await Promise.resolve();
    const approveCall = runner.calls.find((call) => call.args.includes("approve"));
    expect(approveCall?.signal).toBe(controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: "DM_PROCESS_CANCELLED" });
  });

  it("cancels a hung `git credential reject` subprocess via the caller's AbortSignal", async () => {
    const runner = new FakeRunner();
    runner.hangMatcher = (args) => args[0] === "credential" && args[1] === "reject";
    const store = new GitCredentialStore(runner);
    const controller = new AbortController();
    // The `git credential reject` subprocess is held open; aborting the
    // caller's signal must reject the operation because the caller's
    // signal reached the subprocess — pinned here so a future
    // regression that drops the signal would fail this test.
    const promise = store.delete("github", "octocat", controller.signal);
    await Promise.resolve();
    const rejectCall = runner.calls.find((call) => call.args.includes("reject"));
    expect(rejectCall?.signal).toBe(controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: "DM_PROCESS_CANCELLED" });
  });
});
