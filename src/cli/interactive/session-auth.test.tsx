import { render as renderInk } from "ink";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { CommandHandlers } from "../command-handlers.js";
import type { ViewModel } from "../presentation/view-models.js";
import { FakeInkStdin, FakeInkStdout } from "../../test-utils/ink-stdin.js";
import { Session } from "./session.js";

const view: ViewModel = { kind: "verification", text: "ok" };

function handlers(): CommandHandlers {
  return {
    find: vi.fn().mockResolvedValue(view),
    authLogin: vi.fn().mockResolvedValue(view),
    authStatus: vi.fn().mockResolvedValue(view),
    authLogout: vi.fn().mockResolvedValue(view),
    missionAccept: vi.fn().mockResolvedValue(view),
    missionPrepare: vi.fn().mockResolvedValue(view),
    missionResume: vi.fn().mockResolvedValue(view),
    missionCurrent: vi.fn().mockResolvedValue(view),
    missionComplete: vi.fn().mockResolvedValue(view),
    missionBreakLock: vi.fn().mockResolvedValue(view),
    missionAbandon: vi.fn().mockResolvedValue(view),
    agentBrief: vi.fn().mockResolvedValue(view),
    verifySubmission: vi.fn().mockResolvedValue(view),
    verifyLink: vi.fn().mockResolvedValue(view),
    verifyMerge: vi.fn().mockResolvedValue(view),
    journey: vi.fn().mockResolvedValue(view),
    progress: vi.fn().mockResolvedValue(view),
    preferencesGet: vi.fn().mockResolvedValue(view),
    preferencesSet: vi.fn().mockResolvedValue(view),
  };
}

interface Harness {
  readonly stdin: FakeInkStdin;
  readonly stdout: FakeInkStdout;
  readonly unmount: () => void;
}

/**
 * Render the session against a stdin Ink accepts, so real keystrokes drive it.
 * `ink-testing-library` cannot be used here: its stdin has no `ref`, so Ink's
 * `useInput` throws on mount and never receives input.
 */
function mount(props: {
  handlers: CommandHandlers;
  signal: AbortSignal;
  onCancel?: () => void;
  onExit?: () => void;
}): Harness {
  const stdin = new FakeInkStdin();
  const stdout = new FakeInkStdout();
  const instance = renderInk(createElement(Session, props), {
    // The fakes implement only the stream surface Ink touches.
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return { stdin, stdout, unmount: () => instance.unmount() };
}

const settle = (ms = 60): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("session auth interaction", () => {
  it("shows device authorization guidance in the transcript, not on stderr", async () => {
    const commandHandlers = handlers();
    vi.mocked(commandHandlers.authLogin).mockImplementation(async (args) => {
      args.onNotice?.({
        kind: "device-authorization",
        verificationUri: "https://github.com/login/device",
        userCode: "ABCD-1234",
      });
      return view;
    });
    const stderrWrites: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stderrWrites.push(String(chunk));
        return true;
      });
    const harness = mount({ handlers: commandHandlers, signal: new AbortController().signal });
    try {
      await settle();
      harness.stdin.send("/auth login\r");
      await settle();
      expect(harness.stdout.lastFrame()).toContain("https://github.com/login/device");
      expect(harness.stdout.lastFrame()).toContain("ABCD-1234");
    } finally {
      harness.unmount();
      stderrSpy.mockRestore();
    }
    expect(stderrWrites.join("")).not.toContain("ABCD-1234");
  });

  it("routes /auth status through the session to its handler", async () => {
    const commandHandlers = handlers();
    const harness = mount({ handlers: commandHandlers, signal: new AbortController().signal });
    try {
      await settle();
      harness.stdin.send("/auth status\r");
      await settle();
      expect(commandHandlers.authStatus).toHaveBeenCalled();
    } finally {
      harness.unmount();
    }
  });

  it("cancels an in-flight /auth login so the session can close", async () => {
    const commandHandlers = handlers();
    let release: (() => void) | undefined;
    vi.mocked(commandHandlers.authLogin).mockImplementation(
      async () =>
        new Promise<ViewModel>((resolve) => {
          release = () => resolve(view);
        }),
    );
    const onCancel = vi.fn();
    const harness = mount({
      handlers: commandHandlers,
      signal: new AbortController().signal,
      onCancel,
    });
    try {
      await settle();
      harness.stdin.send("/auth login\r");
      await settle();
      expect(commandHandlers.authLogin).toHaveBeenCalled();
      // Ctrl+C while the device flow is still in flight.
      harness.stdin.send("\u0003");
      await settle(20);
      expect(onCancel).toHaveBeenCalled();
    } finally {
      release?.();
      harness.unmount();
    }
  });

  it("leaves an idle Ctrl+C from cancelling anything", async () => {
    const commandHandlers = handlers();
    const onCancel = vi.fn();
    const harness = mount({
      handlers: commandHandlers,
      signal: new AbortController().signal,
      onCancel,
    });
    try {
      await settle();
      harness.stdin.send("\u0003");
      await settle(20);
      expect(onCancel).not.toHaveBeenCalled();
    } finally {
      harness.unmount();
    }
  });
});
