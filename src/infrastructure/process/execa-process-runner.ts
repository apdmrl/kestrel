import { execa } from "execa";
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
    let result;
    try {
      result = await execa(options.executable, [...options.args], {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
        ...(options.signal !== undefined ? { cancelSignal: options.signal } : {}),
        shell: false,
        reject: false,
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.input !== undefined ? { input: options.input } : {}),
        maxBuffer: MAX_OUTPUT_LENGTH,
      });
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        throw notFoundError();
      }
      if ((error as { timedOut?: boolean }).timedOut === true) {
        throw timeoutError();
      }
      if ((error as { isCanceled?: boolean }).isCanceled === true) {
        throw cancelledError();
      }
      throw failedError(error);
    }
    if (result.code === "ENOENT") {
      throw notFoundError();
    }
    if (result.timedOut === true) {
      throw timeoutError();
    }
    if (result.isCanceled === true) {
      throw cancelledError();
    }
    return {
      exitCode: result.exitCode ?? 0,
      stdout: bound(result.stdout),
      stderr: bound(result.stderr),
    };
  }
}
