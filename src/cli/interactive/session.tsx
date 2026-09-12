import { Box, Text, useApp, useInput, useStdin, useStdout } from "ink";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { CommandHandlers } from "../command-handlers.js";
import { createSessionController } from "./session-controller.js";
import {
  DashboardShell,
  DEFAULT_MISSION_SUGGESTIONS,
  DEFAULT_QUICK_COMMANDS,
  estimateEntryRows,
  moveTranscriptPageOffset,
  transcriptViewport,
  type RenderableTranscriptEntry,
  type TerminalCapabilities,
} from "./dashboard.js";
import { actionsForSection, NAVIGATION_SECTIONS } from "./session-navigation.js";
import { parseSessionCommand, SessionParseError } from "./session-parser.js";
import { renderSessionView } from "./session-renderer.js";
import {
  createChildOperation,
  createAdmissionSlot,
  releaseAdmission,
  runStartupAuth,
  tryAdmit,
  type AdmissionSlot,
  type AdmissionToken,
} from "./session-runtime.js";
import {
  initialSessionState,
  isLoginCommand,
  sessionReducer,
  type SessionAuthState,
} from "./session-state.js";
import type { TranscriptEntry } from "./session-view-models.js";

const MAX_TRANSCRIPT_ENTRIES = 200;
const HELP_TEXT = "Try /help for commands · /find to discover a challenge";
const PROMPT_PLACEHOLDER = "Type a command…";
const DEFAULT_STDOUT_COLUMNS = 80;
const DEFAULT_STDOUT_ROWS = 24;
/**
 * `sessionReducer` owns the authoritative auth / operation / latest
 * recommendation state. The reducer dispatches `AUTH_FAILED` /
 * `AUTH_RESOLVED` for `/auth status` and `OPERATION_STARTED` /
 * `OPERATION_FAILED` for every other command, so a classified error
 * code never directly mutates the live state from the component. This
 * is the same transition policy that previously lived in the Session
 * runtime, now centralised in the reducer.
 */
export interface SessionProps {
  readonly handlers: CommandHandlers;
  readonly signal: AbortSignal;
  readonly onExit?: () => void;
  /**
   * Test-injected terminal capabilities. When omitted (the runtime case
   * `src/cli/main.ts` exercises), the Session derives columns/rows from
   * Ink's `useStdout` and subscribes to the `resize` event so the live
   * shell follows the actual terminal dimensions. Tests pass an explicit
   * override so `ink-testing-library` mounts the shell deterministically.
   */
  readonly capabilities?: TerminalCapabilities;
  /**
   * Initial prompt contents. Used by tests to assert the prompt renders
   * the typed command verbatim inside the bounded shell. The real session
   * starts with an empty prompt.
   */
  readonly initialInput?: string;
  /**
   * Initial active category id. Used by tests to position the dashboard
   * sidebar on the action they intend to exercise; the real session starts
   * on `home` and the reducer transitions it from there.
   */
  readonly initialCategory?: string;
}

export interface SessionInputKey {
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly return?: boolean;
  readonly backspace?: boolean;
  readonly delete?: boolean;
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
}

export interface SessionInputTransition {
  readonly nextInput: string;
  readonly submit: boolean;
  readonly cancel: boolean;
}

export function sessionInputTransition(
  current: string,
  character: string,
  key: SessionInputKey,
  busy: boolean,
): SessionInputTransition {
  if (key.ctrl && character === "c") {
    return { nextInput: busy ? current : "", submit: false, cancel: busy };
  }
  if (character === "\r" || character === "\n" || key.return) {
    return { nextInput: current, submit: true, cancel: false };
  }
  if (key.backspace || key.delete) {
    return { nextInput: current.slice(0, -1), submit: false, cancel: false };
  }
  if (!key.ctrl && !key.meta && character.length > 0) {
    return { nextInput: current + character, submit: false, cancel: false };
  }
  return { nextInput: current, submit: false, cancel: false };
}

function appendEntry(
  entries: readonly TranscriptEntry[],
  entry: TranscriptEntry,
): readonly TranscriptEntry[] {
  const next = [...entries, entry];
  return next.length > MAX_TRANSCRIPT_ENTRIES ? next.slice(-MAX_TRANSCRIPT_ENTRIES) : next;
}
function formatError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return "The command could not be completed.";
}

export function TranscriptLine({ entry }: { readonly entry: TranscriptEntry }) {
  if (entry.kind === "error") {
    return (
      <Box borderStyle="round" borderColor="red" paddingX={1} marginTop={1}>
        <Box flexDirection="column">
          <Text color="redBright" bold>
            Action required
          </Text>
          <Text color="red">{entry.text.replace(/^[!×]\s*/u, "")}</Text>
        </Box>
      </Box>
    );
  }
  if (entry.kind === "input") {
    return (
      <Text>
        <Text color="cyan">›</Text> <Text color="white">{entry.text}</Text>
      </Text>
    );
  }
  if (entry.kind === "system") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="white" bold>
          Welcome back
        </Text>
        <Text color="gray">{entry.text.replace(/^✓ Welcome back\n\s*/u, "")}</Text>
      </Box>
    );
  }
  return (
    <Box marginTop={1}>
      <Text color="white">{entry.text}</Text>
    </Box>
  );
}

export function Session({
  handlers,
  signal,
  onExit,
  capabilities: capabilitiesProp,
  initialInput = "",
  initialCategory,
}: SessionProps) {
  const { exit } = useApp();
  const { stdin } = useStdin();
  const { stdout } = useStdout();
  // Derive the runtime capabilities from Ink's stdout so a real TUI
  // session respects the actual terminal dimensions. The explicit
  // `capabilities` prop keeps tests deterministic. Subscribe to `resize`
  // so the live shell re-renders when the user resizes their window.
  const [liveColumns, setLiveColumns] = useState<number>(() =>
    typeof stdout.columns === "number" && stdout.columns > 0
      ? stdout.columns
      : DEFAULT_STDOUT_COLUMNS,
  );
  const [liveRows, setLiveRows] = useState<number>(() =>
    typeof stdout.rows === "number" && stdout.rows > 0 ? stdout.rows : DEFAULT_STDOUT_ROWS,
  );
  useEffect(() => {
    const handleResize = (): void => {
      if (typeof stdout.columns === "number" && stdout.columns > 0) {
        setLiveColumns(stdout.columns);
      }
      if (typeof stdout.rows === "number" && stdout.rows > 0) {
        setLiveRows(stdout.rows);
      }
    };
    stdout.on("resize", handleResize);
    return () => {
      stdout.off("resize", handleResize);
    };
  }, [stdout]);
  const liveCapabilities: TerminalCapabilities = useMemo(
    () => ({ columns: liveColumns, rows: liveRows, color: stdout.isTTY !== false }),
    [liveColumns, liveRows, stdout.isTTY],
  );
  const capabilities = capabilitiesProp ?? liveCapabilities;
  const [input, setInput] = useState(initialInput);
  const [busy, setBusy] = useState(false);
  const nextId = useRef(2);
  const closing = useRef(false);
  const [transcript, setTranscript] = useState<readonly TranscriptEntry[]>([
    { id: 1, kind: "system", text: "✓ Welcome back\n  Type /help to see commands." },
  ]);
  const [transcriptOffsetEntries, setTranscriptOffsetEntries] = useState(0);
  const commandQueue = useRef<string[]>([]);
  const drainingQueue = useRef(false);

  const initialCategoryIndex =
    initialCategory === undefined
      ? 0
      : Math.max(
          0,
          NAVIGATION_SECTIONS.findIndex((section) => section.id === initialCategory),
        );
  const initialSection = NAVIGATION_SECTIONS[initialCategoryIndex] ?? NAVIGATION_SECTIONS[0];
  const [reducerState, dispatch] = useReducer(
    sessionReducer,
    { sectionId: initialSection?.id ?? "home", index: initialCategoryIndex },
    initialSessionState,
  );
  const selectedCategoryIndex = reducerState.selectedSectionIndex;
  const focus = reducerState.focus;
  const selectedActionIndex = reducerState.selectedActionIndex;
  const authState: SessionAuthState = reducerState.auth;
  const currentMission = reducerState.currentMission;
  const activeOperation = useRef<{ controller: AbortController; dispose: () => void } | null>(null);
  // `admissionSlot` is the synchronous admission state. The slot is a
  // pure data object so it can be reasoned about (and tested) without
  // the React renderer. The same shape is exported from
  // `session-runtime.ts` as `AdmissionSlot`; the ref keeps the latest
  // slot snapshot and is read inside `submit()` BEFORE any await.
  const admissionSlot = useRef<AdmissionSlot>(createAdmissionSlot());
  const admissionToken = useRef<AdmissionToken | null>(null);
  // Mount-time startup auth check is owned by an effect. The handle is
  // disposed on unmount so the deadline timer is cleared, the parent
  // abort listener is detached, and no late auth transition is dispatched
  // into a reducer that has already torn down.
  useEffect(() => {
    if (signal.aborted) return;
    const startup = runStartupAuth({
      handlers,
      parentSignal: signal,
      attemptId: nextAttemptId.current,
      dispatch,
    });
    void startup.run.catch(() => {
      // runStartupAuth never rejects; swallow defensive future changes.
    });
    return () => {
      startup.dispose();
    };
  }, []);
  // `submit` bumps the matching counter, captures the value, and uses
  // it as the `operationId` / `attemptId` on the dispatched event. The
  // reducer ignores events whose IDs no longer match the running
  // operation / attempt, so supersession is implicit.
  const nextOperationId = useRef(1);
  const nextAttemptId = useRef(1);
  const addEntry = (kind: TranscriptEntry["kind"], text: string): void => {
    const id = nextId.current;
    nextId.current += 1;
    setTranscript((entries) => appendEntry(entries, { id, kind, text }));
    setTranscriptOffsetEntries(0);
  };
  useEffect(() => {
    if (signal.aborted) return;
    let disposed = false;
    void handlers
      .missionCurrent({}, { signal })
      .then((view) => {
        if (disposed || signal.aborted) return;
        dispatch({
          type: "CURRENT_MISSION_RESOLVED",
          mission: view.kind === "mission" ? view : null,
        });
      })
      .catch((error: unknown) => {
        if (disposed || signal.aborted) return;
        addEntry("error", formatError(error));
      });
    return () => {
      disposed = true;
    };
    // The durable mission is hydrated once. Later mission command results
    // update the reducer directly and cannot be overwritten by this read.
  }, []);
  // Interim guidance (device-flow instructions) must land in the transcript.
  // A raw stderr write would tear the Ink frame it renders inside. The
  // controller delivers a `ViewModel`; route it through `renderSessionView`
  // so auth, error, and device paths use interactive slash-command recovery.
  // The operation refs reject notices that arrive after cancellation.
  const activeOperationForNotice = useRef<{
    readonly operationId: number;
    readonly command: string;
  } | null>(null);
  const childForNotice = useRef<AbortController | null>(null);
  const controller = createSessionController(handlers, (received) => {
    if (received.kind === "device-authorization") {
      const op = activeOperationForNotice.current;
      const childSignal = childForNotice.current?.signal;
      if (
        op === null ||
        !isLoginCommand(op.command) ||
        (childSignal !== undefined && childSignal.aborted)
      ) {
        return;
      }
    }
    const rendered = renderSessionView(received);
    addEntry(rendered.kind, rendered.text);
    if (received.kind === "device-authorization") {
      const op = activeOperationForNotice.current;
      if (op !== null && isLoginCommand(op.command)) {
        dispatch({
          type: "LOGIN_AUTHORIZATION",
          operationId: op.operationId,
          authorization: {
            verificationUri: received.verificationUri,
            userCode: received.userCode,
            expiresAt: Date.now() + 15 * 60 * 1000,
          },
        });
      }
    }
  });
  const close = (): void => {
    if (closing.current) return;
    closing.current = true;
    // Abort the active foreground child before unmounting Ink so
    // device-flow polls, credential helpers, or any other
    // in-flight subprocess are torn down. Without this, /exit (or
    // an outside-in unmount) would close the session while the
    // child signal is still linked to the still-live process
    // lifetime.
    if (activeOperation.current !== null) {
      activeOperation.current.controller.abort();
      activeOperation.current.dispose();
      activeOperation.current = null;
    }
    onExit?.();
    exit();
  };
  // Home is the dashboard root. Both the sidebar and raw Home-key paths
  // share the reducer event so navigation, pending recommendations, and
  // prompt focus cannot drift.
  const selectHome = (): void => {
    dispatch({ type: "HOME_SELECTED" });
    setInput("");
  };
  // Ink recognizes Home internally but does not expose it through useInput's
  // key flags. Intercept only its raw sequence before Ink consumes that
  // chunk; all other keys continue through the primary useInput route.
  useEffect(() => {
    const originalRead = stdin.read;
    stdin.read = ((size?: number) => {
      const chunk = originalRead.call(stdin, size);
      const raw =
        typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString() : "";
      if (raw === "\u001b[H" || raw === "\u001bOH" || raw === "\u001b[1~") {
        selectHome();
        return null;
      }
      if (raw === "\u001b[F" || raw === "\u001bOF" || raw === "\u001b[4~") {
        setTranscriptOffsetEntries(0);
        return null;
      }
      return chunk;
    }) as typeof stdin.read;
    return () => {
      stdin.read = originalRead;
    };
  }, [stdin, selectHome]);
  const submit = async (commandOverride?: string): Promise<void> => {
    const hasCommandOverride = commandOverride !== undefined;
    const commandText = (commandOverride ?? input).trim();
    // Empty / mid-shutdown commands are rejected before any state
    // mutation. Parse / clear / exit are handled below; only those
    // commands that actually install a foreground child get admitted
    // into the synchronous slot.
    if (commandText.length === 0 || closing.current) return;
    const parsed = parseSessionCommand(commandText);
    if (parsed instanceof SessionParseError) {
      addEntry("input", commandText);
      addEntry("error", `! ${parsed.message}`);
      return;
    }
    // /clear and /exit are control commands that must be rejected
    // while the synchronous admission slot is running, per spec
    // §12 (/exit is unavailable while busy) and the same rule
    // for /clear so a foreground child can never be abandoned.
    if ((parsed.kind === "clear" || parsed.kind === "exit") && admissionSlot.current.running) {
      addEntry("input", commandText);
      addEntry("output", "Cannot run /clear or /exit while a command is in flight");
      // Clear the prompt buffer so the rejected command is not
      // silently prepended to the user's next keystrokes.
      if (!hasCommandOverride) setInput("");
      return;
    }
    if (parsed.kind === "clear") {
      addEntry("input", commandText);
      setTranscript([]);
      setTranscriptOffsetEntries(0);
      if (!hasCommandOverride) setInput("");
      return;
    }
    if (parsed.kind === "exit") {
      addEntry("input", commandText);
      if (!hasCommandOverride) setInput("");
      close();
      return;
    }
    if (signal.aborted) {
      addEntry("input", commandText);
      addEntry("error", "! Operation cancelled");
      return;
    }
    // `admissionSlot.current` is the synchronous admission guard: two
    // calls in the same React tick must not both pass the check and
    // install competing children. The slot is a pure data object so the
    // same guard can be exercised by tests without the React renderer.
    // The `busy` state mirrors the slot for the renderer but cannot be
    // relied on for admission because React state updates are deferred.
    const admission = tryAdmit(admissionSlot.current);
    if (admission === null) {
      return;
    }
    admissionSlot.current = admission.slot;
    admissionToken.current = admission.token;
    // Record the admitted command in the transcript exactly once, before
    // clearing the prompt. The parse-error / clear / exit / aborted branches
    // above already record their own input entry; a rejected overlapping
    // submission returns above this point so it never records an entry.
    // The exact recommendation accept command must remain in the typed
    // command line of the transcript — `commandText` is already the trimmed
    // raw input the user typed, so we pass it through verbatim.
    setTranscriptOffsetEntries(0);
    addEntry("input", commandText);
    // Restore prompt clearing for ordinary interactive submit: the user
    // typed a command and pressed Enter, the synchronous guard passed,
    // and no `commandOverride` was supplied (which would be a separately
    // queued CR chunk whose remainder must be preserved in the prompt).
    // A rejected overlapping submission returns above without touching
    // the prompt buffer.
    if (!hasCommandOverride) setInput("");
    // Allocate the reducer IDs for this command BEFORE awaiting the
    // controller. The reducer ignores events whose IDs don't match the
    // running operation/attempt, so a later in-flight event can't
    // accidentally overwrite an older result. The capture-local
    // variables are also how the success/failure branches know which ID
    // to attach to the matching event.
    const commandKind = parsed.kind;
    const isAuthStatus = commandKind === "auth-status";
    const attemptId = isAuthStatus ? ++nextAttemptId.current : nextAttemptId.current;
    const operationId = isAuthStatus ? nextOperationId.current : ++nextOperationId.current;
    if (isAuthStatus) {
      // AUTH_CHECK_STARTED first so a stale AUTH_RESOLVED / AUTH_FAILED
      // from the prior attempt cannot win.
      dispatch({ type: "AUTH_CHECK_STARTED", attemptId });
    } else {
      dispatch({
        type: "OPERATION_STARTED",
        operationId,
        command: commandText,
        cancellable: true,
      });
    }
    // Install the per-command child operation so busy Ctrl+C aborts ONLY
    // this handler, not the lifetime signal. The ref is cleared in
    // `finally` only when its ID still matches — a stale child can't
    // clobber a freshly installed one.
    const child = createChildOperation(signal);
    activeOperation.current = child;
    // Install the notice-channel refs synchronously so the
    // controller's first onAuthorization call sees the active
    // operation AND its child signal even before React re-renders.
    activeOperationForNotice.current = isAuthStatus ? null : { operationId, command: commandText };
    childForNotice.current = child.controller;
    const capturedOperationId = operationId;
    const capturedAttemptId = attemptId;
    setBusy(true);
    try {
      const result = await controller(parsed, { signal: child.controller.signal });
      if (result.kind === "clear") {
        setTranscript([]);
      } else if (result.kind === "exit") {
        close();
      } else if (result.kind === "error") {
        // Detect child-driven cancellation independently of the
        // adapter-specific error code. The session renders neutral
        // cancellation and restores the prior auth state whenever
        // the child signal aborted, even if the handler rejects
        // with an adapter error code that does not match
        // DM_GITHUB_AUTH_CANCELLED (e.g. DM_PROCESS_CANCELLED from
        // a transport-level helper, or a plain Error from a
        // credential lookup). Finding 7 of the implementation
        // review.
        const childAborted = child.controller.signal.aborted;
        const rendered = renderSessionView(result.view);
        const isAuthLogin = !isAuthStatus && parsed.kind === "auth-login";
        if (childAborted && isAuthLogin) {
          addEntry("output", "Login was cancelled; the session remains active.");
          dispatch({ type: "OPERATION_CANCELLED", operationId: capturedOperationId });
        } else {
          addEntry(rendered.kind, rendered.text);
          if (isAuthStatus) {
            const errorCode = result.view.kind === "error" ? result.view.code : "UNKNOWN";
            dispatch({ type: "AUTH_FAILED", attemptId: capturedAttemptId, errorCode });
          } else {
            const errorCode = result.view.kind === "error" ? result.view.code : "UNKNOWN";
            dispatch({ type: "OPERATION_FAILED", operationId: capturedOperationId, errorCode });
          }
        }
      } else {
        const rendered = renderSessionView(result.view);
        addEntry(rendered.kind, rendered.text);
        if (isAuthStatus) {
          const view = result.view;
          if (view.kind === "auth-status") {
            if (view.connected && view.login !== null) {
              dispatch({
                type: "AUTH_RESOLVED",
                attemptId: capturedAttemptId,
                detail: "CONNECTED",
                login: view.login,
              });
            } else if (view.detail === "EXPIRED") {
              dispatch({
                type: "AUTH_RESOLVED",
                attemptId: capturedAttemptId,
                detail: "EXPIRED",
                login: null,
              });
            } else if (view.detail === "NOT_CONNECTED") {
              dispatch({
                type: "AUTH_RESOLVED",
                attemptId: capturedAttemptId,
                detail: "NOT_CONNECTED",
                login: null,
              });
            } else if (view.detail === "LOGGED_OUT") {
              dispatch({
                type: "AUTH_RESOLVED",
                attemptId: capturedAttemptId,
                detail: "NOT_CONNECTED",
                login: null,
              });
            }
          }
        } else {
          if (commandKind === "find" && result.view.kind === "verification") {
            dispatch({ type: "FIND_COMPLETED_EMPTY", operationId: capturedOperationId });
          } else {
            dispatch({
              type: "OPERATION_SUCCEEDED",
              operationId: capturedOperationId,
              view: result.view,
            });
          }
        }
      }
    } catch (error) {
      addEntry("error", formatError(error));
      if (isAuthStatus) {
        dispatch({ type: "AUTH_FAILED", attemptId: capturedAttemptId, errorCode: "UNKNOWN" });
      } else {
        dispatch({
          type: "OPERATION_FAILED",
          operationId: capturedOperationId,
          errorCode: "UNKNOWN",
        });
      }
    } finally {
      // Release the admission slot only when the token still matches the
      // currently-installed active operation. A stale completion (whose
      // child has been replaced by a newer submission) is a no-op — it
      // must not clear a freshly-installed child's busy state, and it
      // must not block Ctrl+C from aborting the newer child. The same
      // identity-check pattern guards the `activeOperation.current`
      // ref so the two refs stay in sync.
      const release = releaseAdmission(admissionSlot.current, admission.token);
      admissionSlot.current = release.slot;
      if (release.released && activeOperation.current === child) {
        activeOperation.current = null;
        admissionToken.current = null;
        setBusy(false);
      }
      child.dispose();
      // Clear the notice-channel refs so a late device-authorization
      // notice (arriving after the operation completed) cannot
      // dispatch a LOGIN_AUTHORIZATION into the reducer for an
      // already-finished operation id, and so the abort-check
      // refuses stale notices too.
      if (activeOperationForNotice.current?.operationId === capturedOperationId) {
        activeOperationForNotice.current = null;
      }
      if (childForNotice.current === child.controller) {
        childForNotice.current = null;
      }
    }
  };
  // Cancel the in-flight foreground child operation. Busy Ctrl+C must
  // abort only the current command so the session can keep accepting
  // new ones; the lifetime signal stays untouched.
  const drainQueue = async (commands: readonly string[]): Promise<void> => {
    // Filter out `/clear` and `/exit` commands queued while the
    // admission slot is busy. They cannot run until the slot is
    // free, but if they remain in `commandQueue` the drain loop
    // will re-submit them after the slot releases (e.g. once
    // Ctrl+C aborts the prior child), reaching `close()` and
    // unmounting Ink — contrary to SESSION-EXIT-002. The
    // rejection notice is rendered here exactly once so the
    // transcript reflects the user's intent, and the queued
    // duplicate never reaches `submit` again.
    const accepted: string[] = [];
    for (const cmd of commands) {
      const trimmed = cmd.trim();
      const isControl =
        trimmed === "/exit" ||
        trimmed === "/clear" ||
        trimmed.startsWith("/exit ") ||
        trimmed.startsWith("/clear ");
      if (!isControl || !admissionSlot.current.running) {
        accepted.push(cmd);
      } else {
        addEntry("input", trimmed);
        addEntry("output", "Cannot run /clear or /exit while a command is in flight");
      }
    }
    commandQueue.current.push(...accepted);
    if (drainingQueue.current) return;
    drainingQueue.current = true;
    try {
      while (commandQueue.current.length > 0 && !closing.current) {
        const command = commandQueue.current.shift();
        if (command !== undefined) await submit(command);
      }
    } finally {
      drainingQueue.current = false;
    }
  };

  const activeSection = NAVIGATION_SECTIONS[selectedCategoryIndex] ?? NAVIGATION_SECTIONS[0];
  const activeSectionId = activeSection?.id ?? "home";
  const contextActions = useMemo(
    () => actionsForSection(activeSectionId, authState, reducerState.latestRecommendation),
    [activeSectionId, authState, reducerState.latestRecommendation],
  );
  const clampedActionIndex =
    contextActions.length === 0 ? -1 : Math.min(selectedActionIndex, contextActions.length - 1);
  const viewport = transcriptViewport(capabilities, contextActions);
  const transcriptPageRows = Math.max(1, viewport.rowBudget - 1);
  const renderableEntries = useMemo<readonly RenderableTranscriptEntry[]>(() => {
    const width = viewport.paneWidth;
    const base: RenderableTranscriptEntry[] = transcript.map((entry) => ({
      id: entry.id,
      text: entry.text,
      kind: entry.kind,
      rows: estimateEntryRows(entry.text, entry.kind, width),
    }));
    if (transcript.length === 1 && transcript[0]?.kind === "system") {
      base.push({
        id: -1,
        text: HELP_TEXT,
        kind: "output",
        rows: estimateEntryRows(HELP_TEXT, "output", width),
      });
    }
    return base;
  }, [transcript, viewport.paneWidth]);
  useInput(
    (character, key) => {
      const typed = typeof character === "string" ? character : "";
      const keyFlags = key ?? {};
      if (keyFlags.pageUp) {
        setTranscriptOffsetEntries((offset) =>
          moveTranscriptPageOffset(renderableEntries, transcriptPageRows, offset, "older"),
        );
        return;
      }
      if (keyFlags.pageDown) {
        setTranscriptOffsetEntries((offset) =>
          moveTranscriptPageOffset(renderableEntries, transcriptPageRows, offset, "newer"),
        );
        return;
      }
      if (typed === "\u001b[H" || typed === "\u001bOH" || typed === "\u001b[1~") {
        selectHome();
        return;
      }
      if (keyFlags.upArrow) {
        if (focus === "actions") {
          const index =
            contextActions.length === 0
              ? 0
              : (clampedActionIndex - 1 + contextActions.length) % contextActions.length;
          dispatch({ type: "ACTION_SELECTED", index });
          return;
        }
        if (focus === "prompt") {
          dispatch({ type: "FOCUS_CHANGED", focus: "sidebar" });
          return;
        }
        const index =
          (selectedCategoryIndex - 1 + NAVIGATION_SECTIONS.length) % NAVIGATION_SECTIONS.length;
        const section = NAVIGATION_SECTIONS[index];
        if (section !== undefined) {
          dispatch({ type: "SECTION_SELECTED", sectionId: section.id, index });
        }
        return;
      }
      if (keyFlags.downArrow) {
        if (focus === "actions") {
          const index =
            contextActions.length === 0 ? 0 : (clampedActionIndex + 1) % contextActions.length;
          dispatch({ type: "ACTION_SELECTED", index });
          return;
        }
        if (focus === "prompt") {
          dispatch({ type: "FOCUS_CHANGED", focus: "sidebar" });
          return;
        }
        const index = (selectedCategoryIndex + 1) % NAVIGATION_SECTIONS.length;
        const section = NAVIGATION_SECTIONS[index];
        if (section !== undefined) {
          dispatch({ type: "SECTION_SELECTED", sectionId: section.id, index });
        }
        return;
      }
      const isReturnKey = typed === "\r" || typed === "\n" || keyFlags.return === true;
      if (!isReturnKey) {
        const lineBreak = typed.search(/[\r\n]/u);
        if (lineBreak >= 0) {
          const lines = typed.split(/\r\n|\r|\n/u);
          const first = input + (lines.shift() ?? "");
          const remainder = lines.pop() ?? "";
          const commands = [first, ...lines];
          setInput(remainder);
          queueMicrotask(() => {
            void drainQueue(commands);
          });
          return;
        }
      }
      const transition = sessionInputTransition(input, typed, keyFlags, busy);
      if (transition.cancel) {
        if (admissionSlot.current.running && activeOperation.current !== null) {
          activeOperation.current.controller.abort();
        }
        return;
      }
      if (transition.submit) {
        if (focus === "actions") {
          const action = contextActions[clampedActionIndex];
          if (action !== undefined && action.availability.status === "enabled") {
            setInput(action.command);
            dispatch({ type: "FOCUS_CHANGED", focus: "prompt" });
          }
          return;
        }
        if (focus === "sidebar" && activeSectionId === "home") {
          selectHome();
          return;
        }
        if (focus === "sidebar" && contextActions.length > 0) {
          dispatch({ type: "ACTION_SELECTED", index: 0 });
          dispatch({ type: "FOCUS_CHANGED", focus: "actions" });
          return;
        }
        void submit();
        return;
      }
      setInput(transition.nextInput);
    },
    { isActive: true },
  );

  // The status bar reflects the live auth state when it is
  // "unknown" so the user sees the failure reason instead of
  // an empty "Ready" placeholder. Spec §9.3 and §13.3 require a
  // visible explanation for offline / external-dependency
  // failures; the recovery action remains `/auth status`.
  const status = ((): string => {
    if (busy) return "Working";
    if (authState.status === "unknown") {
      return `Auth status unavailable (${authState.errorCode})`;
    }
    return "Ready";
  })();
  const sessionStatus = "active";
  return (
    <DashboardShell
      status={status}
      title="Mission Control"
      subtitle="Welcome back"
      sessionStatus={sessionStatus}
      mission={
        currentMission === null
          ? {
              title: "No active mission",
              description: "Discover a challenge or resume your current engineering work.",
              suggestions: DEFAULT_MISSION_SUGGESTIONS,
            }
          : {
              title: currentMission.title,
              description: [currentMission.status, currentMission.repository, currentMission.branch]
                .filter((part): part is string => part !== undefined)
                .join(" · "),
              suggestions: DEFAULT_MISSION_SUGGESTIONS,
            }
      }
      stats={[]}
      quickCommands={DEFAULT_QUICK_COMMANDS}
      selectedNavigationIndex={selectedCategoryIndex}
      focusedNavigationIndex={focus === "sidebar" ? selectedCategoryIndex : -1}
      input={input}
      busy={busy}
      placeholder={PROMPT_PLACEHOLDER}
      capabilities={capabilities}
      contextActions={contextActions}
      selectedActionIndex={clampedActionIndex}
      actionFocused={focus === "actions"}
      transcriptOffsetEntries={transcriptOffsetEntries}
      entries={renderableEntries}
    />
  );
}
