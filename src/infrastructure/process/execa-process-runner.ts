import { execa } from "execa";
import { createKestrelError } from "../../application/errors/kestrel-error.js";
import type {
  ProcessResult,
  ProcessRunner,
  RunProcessOptions,
} from "../../ports/process-runner.js";

const MAX_OUTPUT_LENGTH = 64 * 1024;

const SECRET_PATTERN = /\b(token|password|secret|authorization)\b\s*[:=]\s*[^\s]+/gi;

function redactText(text: string): string {
  return text.replace(SECRET_PATTERN, "$1=***");
}

function bound(text: string): string {
  if (text.length <= MAX_OUTPUT_LENGTH) {
    return text;
  }
  return text.slice(0, MAX_OUTPUT_LENGTH) + "\n...[output truncated]";
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
      stdout: redactText(bound(result.stdout)),
      stderr: redactText(bound(result.stderr)),
    };
  }
}
