import { EventEmitter } from "node:events";

/**
 * Minimal stdin that satisfies Ink's `useInput`.
 *
 * `ink-testing-library`'s stdin omits `ref`/`unref`, which Ink calls through
 * `handleSetRawMode`, so `useInput` throws on mount and no keystroke can be
 * delivered. This harness supplies the missing stream surface so interactive
 * key handling can be exercised for real instead of only through the pure
 * `sessionInputTransition` reducer.
 */
export class FakeInkStdin extends EventEmitter {
  readonly isTTY = true;
  /** Pending chunks, drained by read() the way Ink's handleReadable expects. */
  private readonly queue: string[] = [];

  setRawMode(): this {
    return this;
  }

  setEncoding(): this {
    return this;
  }

  resume(): this {
    return this;
  }

  pause(): this {
    return this;
  }

  ref(): void {
    // Ink keeps the process alive through the input stream; nothing to do here.
  }

  unref(): void {
    // Counterpart to ref(); the fake stream owns no handle.
  }

  /**
   * Ink reads input by draining read() until it returns null, driven by the
   * `readable` event, so this must be a pull-style stream rather than emitting
   * `data` events.
   */
  read(): string | null {
    return this.queue.shift() ?? null;
  }

  /** Deliver keystrokes to Ink exactly as a TTY would. */
  send(data: string): void {
    this.queue.push(data);
    this.emit("readable");
  }
}

/** Collects rendered Ink frames so assertions can read the latest one. */
export class FakeInkStdout extends EventEmitter {
  readonly columns = 100;
  readonly rows = 40;
  readonly frames: string[] = [];

  write(data: string): boolean {
    this.frames.push(data);
    return true;
  }

  lastFrame(): string {
    return this.frames[this.frames.length - 1] ?? "";
  }
}
