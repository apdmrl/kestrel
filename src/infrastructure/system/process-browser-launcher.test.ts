import { describe, expect, it } from "vitest";
import { createKestrelError } from "../../application/errors/kestrel-error.js";
import type {
  ProcessResult,
  ProcessRunner,
  RunProcessOptions,
} from "../../ports/process-runner.js";
import { ProcessBrowserLauncher } from "./process-browser-launcher.js";

const URL_TO_OPEN = "https://github.com/login/device";

interface Call {
  readonly executable: string;
  readonly args: readonly string[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

class FakeRunner implements ProcessRunner {
  readonly calls: Call[] = [];
  exitCode = 0;
  failWith?: unknown;
  /** Executables that should behave as if missing from PATH. */
  missing = new Set<string>();

  async run(options: RunProcessOptions): Promise<ProcessResult> {
    this.calls.push({
      executable: options.executable,
      args: [...options.args],
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    if (this.missing.has(options.executable)) {
      throw createKestrelError({
        code: "DM_PROCESS_NOT_FOUND",
        category: "USER_ACTION_REQUIRED",
        userMessage: "The requested executable was not found",
        suggestedActions: ["Install the executable, or add it to PATH"],
        retryability: "NO_RETRY",
        recoveryStrategy: "USER_ACTION",
        severity: "ERROR",
      });
    }
    if (this.failWith !== undefined) {
      throw this.failWith;
    }
    return { exitCode: this.exitCode, stdout: "", stderr: "" };
  }
}

describe("ProcessBrowserLauncher", () => {
  it("opens a url with xdg-open on linux", async () => {
    const runner = new FakeRunner();
    const opened = await new ProcessBrowserLauncher(runner, "linux").open(URL_TO_OPEN);
    expect(opened).toBe(true);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.executable).toBe("xdg-open");
    expect(runner.calls[0]?.args).toEqual([URL_TO_OPEN]);
  });

  it("opens a url with open on darwin", async () => {
    const runner = new FakeRunner();
    const opened = await new ProcessBrowserLauncher(runner, "darwin").open(URL_TO_OPEN);
    expect(opened).toBe(true);
    expect(runner.calls[0]?.executable).toBe("open");
    expect(runner.calls[0]?.args).toEqual([URL_TO_OPEN]);
  });

  it("opens a url through rundll32 on win32, never through a shell builtin", async () => {
    const runner = new FakeRunner();
    const opened = await new ProcessBrowserLauncher(runner, "win32").open(URL_TO_OPEN);
    expect(opened).toBe(true);
    expect(runner.calls[0]?.executable).toBe("rundll32.exe");
    expect(runner.calls[0]?.args).toEqual(["url.dll,FileProtocolHandler", URL_TO_OPEN]);
  });

  it("prefers wslview on wsl", async () => {
    const runner = new FakeRunner();
    const opened = await new ProcessBrowserLauncher(runner, "wsl").open(URL_TO_OPEN);
    expect(opened).toBe(true);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.executable).toBe("wslview");
  });

  it("falls back to xdg-open on wsl when wslview is not installed", async () => {
    const runner = new FakeRunner();
    runner.missing.add("wslview");
    const opened = await new ProcessBrowserLauncher(runner, "wsl").open(URL_TO_OPEN);
    expect(opened).toBe(true);
    expect(runner.calls.map((call) => call.executable)).toEqual(["wslview", "xdg-open"]);
  });

  it("bounds the launch with a timeout so a hung launcher cannot stall authentication", async () => {
    const runner = new FakeRunner();
    await new ProcessBrowserLauncher(runner, "linux").open(URL_TO_OPEN);
    expect(runner.calls[0]?.timeoutMs).toBeGreaterThan(0);
  });

  it("forwards the cancellation signal to the launcher process", async () => {
    const runner = new FakeRunner();
    const controller = new AbortController();
    await new ProcessBrowserLauncher(runner, "linux").open(URL_TO_OPEN, controller.signal);
    expect(runner.calls[0]?.signal).toBe(controller.signal);
  });

  it("reports false without launching when the url is not https", async () => {
    const runner = new FakeRunner();
    const launcher = new ProcessBrowserLauncher(runner, "linux");
    expect(await launcher.open("http://github.com/login/device")).toBe(false);
    expect(runner.calls).toHaveLength(0);
  });

  it("refuses javascript, file, and data urls without launching", async () => {
    const runner = new FakeRunner();
    const launcher = new ProcessBrowserLauncher(runner, "linux");
    expect(await launcher.open("javascript:alert(1)")).toBe(false);
    expect(await launcher.open("file:///etc/passwd")).toBe(false);
    expect(await launcher.open("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(runner.calls).toHaveLength(0);
  });

  it("refuses a malformed url without launching", async () => {
    const runner = new FakeRunner();
    const launcher = new ProcessBrowserLauncher(runner, "linux");
    expect(await launcher.open("not a url")).toBe(false);
    expect(await launcher.open("")).toBe(false);
    expect(runner.calls).toHaveLength(0);
  });

  it("refuses an https url carrying embedded credentials without launching", async () => {
    const runner = new FakeRunner();
    const launcher = new ProcessBrowserLauncher(runner, "linux");
    expect(await launcher.open("https://user:pass@github.com/login/device")).toBe(false);
    expect(await launcher.open("https://token@github.com/login/device")).toBe(false);
    expect(runner.calls).toHaveLength(0);
  });

  it("refuses a userinfo url that impersonates github, the classic phishing form", async () => {
    const runner = new FakeRunner();
    const launcher = new ProcessBrowserLauncher(runner, "linux");
    expect(await launcher.open("https://github.com@evil.example/login/device")).toBe(false);
    expect(runner.calls).toHaveLength(0);
  });

  it("preserves a query string exactly, which is why win32 avoids the shell", async () => {
    const runner = new FakeRunner();
    const url = "https://github.com/login/device?a=1&b=2";
    expect(await new ProcessBrowserLauncher(runner, "win32").open(url)).toBe(true);
    expect(runner.calls[0]?.args).toEqual(["url.dll,FileProtocolHandler", url]);
  });

  it("reports false when the launcher exits non-zero", async () => {
    const runner = new FakeRunner();
    runner.exitCode = 3;
    expect(await new ProcessBrowserLauncher(runner, "linux").open(URL_TO_OPEN)).toBe(false);
  });

  it("reports false instead of throwing when the runner raises a classified error", async () => {
    const runner = new FakeRunner();
    runner.failWith = createKestrelError({
      code: "DM_PROCESS_TIMEOUT",
      category: "TRANSIENT",
      userMessage: "The command timed out",
      suggestedActions: ["Retry with a longer timeout"],
      retryability: "RETRYABLE",
      recoveryStrategy: "RETRY",
      severity: "ERROR",
    });
    expect(await new ProcessBrowserLauncher(runner, "linux").open(URL_TO_OPEN)).toBe(false);
  });

  it("reports false instead of throwing when the runner raises an unclassified error", async () => {
    const runner = new FakeRunner();
    runner.failWith = new Error("spawn exploded");
    expect(await new ProcessBrowserLauncher(runner, "linux").open(URL_TO_OPEN)).toBe(false);
  });

  it("reports false rather than propagating a cancellation", async () => {
    const runner = new FakeRunner();
    runner.failWith = createKestrelError({
      code: "DM_PROCESS_CANCELLED",
      category: "USER_ACTION_REQUIRED",
      userMessage: "The command was cancelled",
      suggestedActions: ["Run the command again when ready"],
      retryability: "NO_RETRY",
      recoveryStrategy: "USER_ACTION",
      severity: "INFO",
    });
    expect(await new ProcessBrowserLauncher(runner, "linux").open(URL_TO_OPEN)).toBe(false);
  });

  it("reports false when both wsl launchers fail", async () => {
    const runner = new FakeRunner();
    runner.missing.add("wslview");
    runner.missing.add("xdg-open");
    expect(await new ProcessBrowserLauncher(runner, "wsl").open(URL_TO_OPEN)).toBe(false);
  });
});
