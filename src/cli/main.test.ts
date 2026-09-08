import { EventEmitter } from "node:events";
import type { Instance, RenderOptions, render as InkRender } from "ink";
import { describe, expect, it } from "vitest";
import type { CommandHandlers } from "./command-handlers.js";
import {
  ALTERNATE_SCREEN_ENTER,
  ALTERNATE_SCREEN_EXIT,
  SYNCHRONIZED_OUTPUT_BEGIN,
  SYNCHRONIZED_OUTPUT_END,
} from "./presentation/atomic-terminal-session.js";
import { createSignalHandler, runInteractiveSession } from "./main.js";

class FakeTerminalOutput extends EventEmitter {
  readonly isTTY = true;
  readonly writes: string[] = [];
  columns = 80;
  rows = 24;

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }
}

function input(): NodeJS.ReadStream {
  return { isTTY: true } as NodeJS.ReadStream;
}

function instance(overrides: Partial<Instance> = {}): Instance {
  return {
    rerender: () => undefined,
    unmount: () => undefined,
    waitUntilExit: async () => undefined,
    cleanup: () => undefined,
    clear: () => undefined,
    ...overrides,
  };
}

function renderFrame(app: Instance): typeof InkRender {
  return ((_node: unknown, options?: RenderOptions) => {
    expect(options?.stdout).toBeDefined();
    options?.stdout?.write("frame");
    return app;
  }) as typeof InkRender;
}

describe("runInteractiveSession", () => {

  it("mounts Ink inside the atomic terminal session and restores it after normal exit", async () => {
    const output = new FakeTerminalOutput();

    await runInteractiveSession({
      handlers: {} as CommandHandlers,
      signal: new AbortController().signal,
      stdin: input(),
      stdout: output as unknown as NodeJS.WriteStream,
      render: renderFrame(instance()),
    });

    expect(output.writes).toEqual([
      ALTERNATE_SCREEN_ENTER,
      SYNCHRONIZED_OUTPUT_BEGIN,
      "frame",
      SYNCHRONIZED_OUTPUT_END,
      ALTERNATE_SCREEN_EXIT,
    ]);
  });

  it("restores the alternate screen when Ink mounting throws", async () => {
    const output = new FakeTerminalOutput();
    const failure = new Error("render failed");

    await expect(
      runInteractiveSession({
        handlers: {} as CommandHandlers,
        signal: new AbortController().signal,
        stdin: input(),
        stdout: output as unknown as NodeJS.WriteStream,
        render: (() => {
          throw failure;
        }) as typeof InkRender,
      }),
    ).rejects.toBe(failure);

    expect(output.writes).toEqual([ALTERNATE_SCREEN_ENTER, ALTERNATE_SCREEN_EXIT]);
  });

  it("unmounts and restores the terminal when the session is aborted", async () => {
    const output = new FakeTerminalOutput();
    const controller = new AbortController();
    let resolveExit: (() => void) | undefined;
    const waitUntilExit = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const app = instance({
      unmount: () => resolveExit?.(),
      waitUntilExit: async () => waitUntilExit,
    });

    const running = runInteractiveSession({
      handlers: {} as CommandHandlers,
      signal: controller.signal,
      stdin: input(),
      stdout: output as unknown as NodeJS.WriteStream,
      render: renderFrame(app),
    });
    controller.abort();
    await running;

    expect(output.writes).toEqual([
      ALTERNATE_SCREEN_ENTER,
      SYNCHRONIZED_OUTPUT_BEGIN,
      "frame",
      SYNCHRONIZED_OUTPUT_END,
      ALTERNATE_SCREEN_EXIT,
    ]);
  });
});

describe("createSignalHandler", () => {
  it("restores an active terminal session before a second signal forces exit", () => {
    const controller = new AbortController();
    const events: string[] = [];
    const onSignal = createSignalHandler({
      controller,
      getActiveSessionCleanup: () => () => events.push("cleanup"),
      exit: (code) => {
        events.push(`exit:${code}`);
      },
    });

    onSignal();
    expect(controller.signal.aborted).toBe(true);
    expect(events).toEqual([]);

    onSignal();

    expect(events).toEqual(["cleanup", "exit:130"]);
  });
});
