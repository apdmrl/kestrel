export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunProcessOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly env?: Readonly<Record<string, string>>;
  readonly input?: string;
}

/**
 * Argument-safe process execution. Never accepts a shell command string.
 * Completed processes (including non-zero exits) return a ProcessResult;
 * failures to launch, timeouts, and cancellations throw a classified KestrelError.
 */
export interface ProcessRunner {
  run(options: RunProcessOptions): Promise<ProcessResult>;
}
