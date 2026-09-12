import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { isAbsolute, join } from "node:path";
import { createKestrelError } from "../../application/errors/kestrel-error.js";
import type {
  ProcessResult,
  ProcessRunner,
  RunProcessOptions,
} from "../../ports/process-runner.js";

const MAX_OUTPUT_LENGTH = 64 * 1024;

function bound(text: string): string {
  if (text.length <= MAX_OUTPUT_LENGTH) {
    return text;
  }
  return text.slice(0, MAX_OUTPUT_LENGTH) + "\n...[output truncated]";
}

/**
 * Whether an executable name resolves to a file on PATH (or an absolute path).
 * A missing executable manifests as an ENOENT spawn error on POSIX but as a
 * plain exit-code-1 result on Windows, so existence is checked explicitly to
 * classify it as NOT_FOUND consistently across platforms.
 */
export function executableExists(executable: string): boolean {
  const win = platform() === "win32";
  if (isAbsolute(executable) || executable.includes("/") || (win && executable.includes("\\"))) {
    return existsSync(executable);
  }
  const pathSep = win ? ";" : ":";
  const pathExts = win
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter((e) => e.length > 0)
    : [""];
  for (const dir of (process.env.PATH ?? "").split(pathSep)) {
    if (dir.length === 0) {
      continue;
    }
    const base = join(dir, executable);
    for (const ext of pathExts) {
      if (existsSync(base + ext)) {
        return true;
      }
    }
    if (!win && existsSync(base)) {
      return true;
    }
  }
  return false;
}

function notFoundError() {
  return createKestrelError({
    code: "DM_PROCESS_NOT_FOUND",
    category: "USER_ACTION_REQUIRED",
    userMessage: "The requested executable was not found",
    suggestedActions: ["Install the executable, or add it to PATH"],
    retryability: "NO_RETRY",
    recoveryStrategy: "USER_ACTION",
    severity: "ERROR",
  });
}

function timeoutError() {
  return createKestrelError({
    code: "DM_PROCESS_TIMEOUT",
    category: "TRANSIENT",
    userMessage: "The command timed out",
    suggestedActions: ["Retry with a longer timeout"],
    retryability: "RETRYABLE",
    recoveryStrategy: "RETRY",
    severity: "ERROR",
  });
}

function cancelledError() {
  return createKestrelError({
    code: "DM_PROCESS_CANCELLED",
    category: "USER_ACTION_REQUIRED",
    userMessage: "The command was cancelled",
    suggestedActions: ["Run the command again when ready"],
    retryability: "NO_RETRY",
    recoveryStrategy: "USER_ACTION",
    severity: "INFO",
  });
}

function failedError(cause: unknown) {
  return createKestrelError({
    code: "DM_PROCESS_FAILED",
    category: "TRANSIENT",
    userMessage: "The command failed to run",
    suggestedActions: ["Retry the operation"],
    retryability: "RETRYABLE",
    recoveryStrategy: "RETRY",
    severity: "ERROR",
    cause,
  });
}

export class ExecaProcessRunner implements ProcessRunner {
  async run(options: RunProcessOptions): Promise<ProcessResult> {
    if (!executableExists(options.executable)) {
      throw notFoundError();
    }
    const isPosix = platform() !== "win32";
    // Spawn the child via `node:child_process.spawn` directly so
    // the runner owns the lifecycle. `execa`'s `cancelSignal` only
    // kills the direct child via `subprocess.kill()`, which leaves
    // a real Git credential helper (a descendant of the direct git
    // child) holding the stdout/stderr streams open — the runner's
    // promise would never settle. With `detached: true` the child
    // is its own process group leader; on AbortSignal the runner
    // sends SIGTERM to the negated child PID so the entire group —
    // including any `git credential fill` helper — receives the
    // signal. PROCESS-TREE-004 evidence lives in
    // `execa-process-runner-helper-fixture.test.ts`.
    const child: ChildProcess = spawn(options.executable, [...options.args], {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: { ...options.env } } : {}),
      detached: isPosix,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    } else {
      child.stdin?.end();
    }
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    const childPid = child.pid;
    let groupKillListener: (() => void) | undefined;
    if (options.signal !== undefined && isPosix && typeof childPid === "number" && childPid > 0) {
      const parentSignal = options.signal;
      groupKillListener = (): void => {
        try {
          process.kill(-childPid, "SIGTERM");
        } catch {
          // group already gone or never created
        }
      };
      parentSignal.addEventListener("abort", groupKillListener);
    }
    let timer: NodeJS.Timeout | undefined;
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        if (isPosix && typeof childPid === "number" && childPid > 0) {
          try {
            process.kill(-childPid, "SIGKILL");
          } catch {
            // ignore
          }
        } else {
          child.kill("SIGKILL");
        }
      }, options.timeoutMs);
      timer.unref();
    }
    let settled: { code: number | null; signal: NodeJS.Signals | null };
    try {
      settled = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once("close", (code, sig) => {
            clearTimeout(timer);
            resolve({ code, signal: sig });
          });
        },
      );
    } catch (error) {
      if (groupKillListener !== undefined && options.signal !== undefined) {
        options.signal.removeEventListener("abort", groupKillListener);
      }
      if ((error as { code?: string }).code === "ENOENT") {
        throw notFoundError();
      }
      throw failedError(error);
    }
    if (groupKillListener !== undefined && options.signal !== undefined) {
      options.signal.removeEventListener("abort", groupKillListener);
    }
    const { code, signal } = settled;
    if (signal !== null) {
      if (signal === "SIGTERM" || signal === "SIGKILL" || signal === "SIGINT") {
        if (options.signal?.aborted === true) {
          throw cancelledError();
        }
        if (options.timeoutMs !== undefined) {
          throw timeoutError();
        }
      }
      throw cancelledError();
    }
    if (code === null) {
      throw notFoundError();
    }
    if (code < 0) {
      throw cancelledError();
    }
    return {
      exitCode: code,
      stdout: bound(Buffer.concat(stdoutChunks).toString("utf8")),
      stderr: bound(Buffer.concat(stderrChunks).toString("utf8")),
    };
  }
}
