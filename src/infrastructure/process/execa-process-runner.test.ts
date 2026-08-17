import { describe, expect, it } from "vitest";
import { createKestrelError } from "../../application/errors/kestrel-error.js";
import { ExecaProcessRunner } from "./execa-process-runner.js";
import { mapGitExitCode, mapGitProcessError } from "../git/git-error-mapper.js";

const runner = new ExecaProcessRunner();

describe("ExecaProcessRunner", () => {
  it("preserves arguments without shell interpretation", async () => {
    const result = await runner.run({
      executable: "node",
      args: ["-e", "console.log(process.argv[1])", "arg with spaces"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("arg with spaces");
  });

  it("times out a long-running command", async () => {
    await expect(
      runner.run({
        executable: "node",
        args: ["-e", "setTimeout(() => {}, 5000)"],
        timeoutMs: 200,
      }),
    ).rejects.toMatchObject({ code: "DM_PROCESS_TIMEOUT" });
  });

  it("honors cancellation", async () => {
    const controller = new AbortController();
    const pending = runner.run({
      executable: "node",
      args: ["-e", "setTimeout(() => {}, 5000)"],
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "DM_PROCESS_CANCELLED" });
  });

  it("redacts secret-like values in captured stderr", async () => {
    const result = await runner.run({
      executable: "node",
      args: ["-e", "console.error('token=abc123 password=hunter2')"],
    });
    expect(result.stderr).not.toContain("abc123");
    expect(result.stderr).not.toContain("hunter2");
  });

  it("classifies a missing executable", async () => {
    await expect(
      runner.run({ executable: "definitely-not-a-real-command-xyz", args: [] }),
    ).rejects.toMatchObject({ code: "DM_PROCESS_NOT_FOUND" });
  });

  it("returns a non-zero exit code without throwing", async () => {
    const result = await runner.run({ executable: "node", args: ["-e", "process.exit(3)"] });
    expect(result.exitCode).toBe(3);
  });
});

describe("git-error-mapper", () => {
  it("maps authentication failures", () => {
    const error = mapGitExitCode(128, "remote: Permission denied (publickey).");
    expect(error.code).toBe("DM_GIT_AUTH_FAILED");
  });

  it("maps conflicts", () => {
    const error = mapGitExitCode(1, "error: your local changes would be overwritten");
    expect(error.code).toBe("DM_GIT_CONFLICT");
  });

  it("maps a fatal git failure", () => {
    const error = mapGitExitCode(128, "fatal: not a git repository");
    expect(error.code).toBe("DM_GIT_FATAL");
  });

  it("maps a missing executable to DM_GIT_NOT_FOUND", () => {
    const error = mapGitProcessError(
      createKestrelError({
        code: "DM_PROCESS_NOT_FOUND",
        category: "USER_ACTION_REQUIRED",
        userMessage: "not found",
        suggestedActions: ["install"],
        retryability: "NO_RETRY",
        recoveryStrategy: "USER_ACTION",
        severity: "ERROR",
      }),
    );
    expect(error.code).toBe("DM_GIT_NOT_FOUND");
  });
});
