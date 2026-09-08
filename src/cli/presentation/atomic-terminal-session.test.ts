import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  ALTERNATE_SCREEN_ENTER,
  ALTERNATE_SCREEN_EXIT,
  SYNCHRONIZED_OUTPUT_BEGIN,
  SYNCHRONIZED_OUTPUT_END,
  createAtomicTerminalSession,
} from "./atomic-terminal-session.js";

class FakeTerminalOutput extends EventEmitter {
  readonly writes: string[] = [];
  readonly isTTY: boolean;
  columns = 80;
  rows = 24;

  constructor(isTTY: boolean) {
    super();
    this.isTTY = isTTY;
  }

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }
}

function ttyInput(isTTY: boolean): NodeJS.ReadStream {
  return { isTTY } as NodeJS.ReadStream;
}

describe("createAtomicTerminalSession", () => {
  it("enters the alternate screen before enclosing an Ink frame and exits after cleanup", () => {
    const output = new FakeTerminalOutput(true);
    const session = createAtomicTerminalSession({
      stdin: ttyInput(true),
      stdout: output as unknown as NodeJS.WriteStream,
    });

    session.stdout.write("frame");
    session.cleanup();

    expect(output.writes).toEqual([
      ALTERNATE_SCREEN_ENTER,
      SYNCHRONIZED_OUTPUT_BEGIN,
      "frame",
      SYNCHRONIZED_OUTPUT_END,
      ALTERNATE_SCREEN_EXIT,
    ]);
  });

  it("passes through non-TTY streams without terminal control sequences", () => {
    const output = new FakeTerminalOutput(false);
    const session = createAtomicTerminalSession({
      stdin: ttyInput(true),
      stdout: output as unknown as NodeJS.WriteStream,
    });

    session.stdout.write("plain output");
    session.cleanup();

    expect(session.stdout).toBe(output);
    expect(output.writes).toEqual(["plain output"]);
  });

  it("requires an interactive input stream before activating", () => {
    const output = new FakeTerminalOutput(true);
    const session = createAtomicTerminalSession({
      stdin: ttyInput(false),
      stdout: output as unknown as NodeJS.WriteStream,
    });

    session.stdout.write("plain output");
    session.cleanup();

    expect(output.writes).toEqual(["plain output"]);
  });

  it("keeps terminal dimensions and resize events live through the stdout proxy", () => {
    const output = new FakeTerminalOutput(true);
    const session = createAtomicTerminalSession({
      stdin: ttyInput(true),
      stdout: output as unknown as NodeJS.WriteStream,
    });
    const onResize = (): void => undefined;

    session.stdout.on("resize", onResize);
    output.columns = 120;
    output.rows = 40;
    output.emit("resize");

    expect(session.stdout.columns).toBe(120);
    expect(session.stdout.rows).toBe(40);
    expect(output.listenerCount("resize")).toBe(1);
  });

  it("restores the terminal once when cleanup is repeated", () => {
    const output = new FakeTerminalOutput(true);
    const session = createAtomicTerminalSession({
      stdin: ttyInput(true),
      stdout: output as unknown as NodeJS.WriteStream,
    });

    session.cleanup();
    session.cleanup();

    expect(output.writes).toEqual([ALTERNATE_SCREEN_ENTER, ALTERNATE_SCREEN_EXIT]);
  });
});
