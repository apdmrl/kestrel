export const ALTERNATE_SCREEN_ENTER = "\u001B[?1049h";
export const ALTERNATE_SCREEN_EXIT = "\u001B[?1049l";
export const SYNCHRONIZED_OUTPUT_BEGIN = "\u001B[?2026h";
export const SYNCHRONIZED_OUTPUT_END = "\u001B[?2026l";

export interface AtomicTerminalSession {
  readonly stdout: NodeJS.WriteStream;
  cleanup(): void;
}

export interface AtomicTerminalSessionOptions {
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
}

/**
 * Provides Ink with a live stdout stream that makes each frame atomic on a
 * real terminal. Piped output is returned unchanged so machine-readable and
 * one-shot commands never receive terminal control sequences.
 */
export function createAtomicTerminalSession(
  options: AtomicTerminalSessionOptions,
): AtomicTerminalSession {
  const { stdin, stdout } = options;
  if (stdin.isTTY !== true || stdout.isTTY !== true) {
    return { stdout, cleanup: () => {} };
  }

  stdout.write(ALTERNATE_SCREEN_ENTER);
  let cleaned = false;
  const atomicWrite = ((...args: Parameters<NodeJS.WriteStream["write"]>): boolean => {
    stdout.write(SYNCHRONIZED_OUTPUT_BEGIN);
    try {
      return stdout.write(...args);
    } finally {
      stdout.write(SYNCHRONIZED_OUTPUT_END);
    }
  }) as NodeJS.WriteStream["write"];
  const atomicStdout = new Proxy(stdout, {
    get(target, property) {
      if (property === "write") return atomicWrite;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return {
    stdout: atomicStdout,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      stdout.write(ALTERNATE_SCREEN_EXIT);
    },
  };
}
