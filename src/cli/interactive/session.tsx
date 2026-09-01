import { Box, Text, useApp, useInput, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { CommandHandlers } from "../command-handlers.js";
import type { RecommendationViewModel } from "../presentation/view-models.js";
import { createSessionController } from "./session-controller.js";
import {
  DashboardShell,
  DEFAULT_MISSION_SUGGESTIONS,
  DEFAULT_QUICK_COMMANDS,
  estimateEntryRows,
  isCriticalTranscriptText,
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
  sessionReducer,
  type SessionAuthState,
  type SessionEvent,
} from "./session-state.js";
import type { TranscriptEntry } from "./session-view-models.js";

const MAX_TRANSCRIPT_ENTRIES = 200;
const HELP_TEXT = "Try /help for commands · /find to discover a challenge";
const FALLBACK_CAPABILITIES: TerminalCapabilities = { columns: 80, rows: 24, color: true };
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
  /**
   * Pre-loaded recommendation. Lets tests drive the contextual action
   * panel with the exact `RecommendationViewModel` that produced the
   * accept command — mirroring what the controller's notify channel
   * captures from a successful `/find`.
   */
  readonly latestRecommendation?: RecommendationViewModel | null;
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

/**
 * Local focus model for the interactive session. Until Task 5 replaces
 * this with the reducer-driven state machine, the Session owns its own
 * minimal transient state: which category is selected, whether the
 * sidebar / action panel / prompt has focus, and which contextual action
 * is currently armed.
 */
type SessionFocus = "prompt" | "sidebar" | "actions";

export function Session({
  handlers,
  signal,
  onExit,
  capabilities: capabilitiesProp,
  initialInput = "",
  initialCategory,
  latestRecommendation: latestRecommendationProp = null,
}: SessionProps) {
  const { exit } = useApp();
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
    typeof stdout.rows === "number" && stdout.rows > 0
      ? stdout.rows
      : DEFAULT_STDOUT_ROWS,
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
  const commandQueue = useRef<string[]>([]);
  const drainingQueue = useRef(false);

  // Transient navigation state. Task 5 replaces this with `sessionReducer`.
  const initialCategoryIndex = initialCategory !== undefined
    ? Math.max(0, NAVIGATION_SECTIONS.findIndex((section) => section.id === initialCategory))
    : 0;
  const [selectedCategoryIndex, setSelectedCategoryIndex] = useState(initialCategoryIndex);
  const [focus, setFocus] = useState<SessionFocus>("prompt");
  const [selectedActionIndex, setSelectedActionIndex] = useState(0);
  const [actionFocused, setActionFocused] = useState(false);
  const [reducerState, dispatch] = useReducer(sessionReducer, undefined, initialSessionState);
  const authState: SessionAuthState = reducerState.auth;
  const reducerLatestRecommendation = reducerState.latestRecommendation;
  const [latestRecommendation, setLatestRecommendation] =
    useState<RecommendationViewModel | null>(latestRecommendationProp);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const latestRecommendationRef = useRef<RecommendationViewModel | null>(latestRecommendationProp);
  // The reducer reports `latestRecommendation` via `OPERATION_SUCCEEDED`;
  // mirror it into React state so the contextual action panel sees the
  // latest value. The reducer remains the authoritative source.
  // `submit` bumps the matching counter, captures the value, and uses
  // it as the `operationId` / `attemptId` on the dispatched event. The
  // reducer ignores events whose IDs no longer match the running
  // operation / attempt, so supersession is implicit.
  const nextOperationId = useRef(1);
  const nextAttemptId = useRef(1);
  useEffect(() => {
    if (reducerLatestRecommendation !== null) {
      if (latestRecommendationRef.current?.recommendationId !== reducerLatestRecommendation.recommendationId) {
        latestRecommendationRef.current = reducerLatestRecommendation;
        setLatestRecommendation(reducerLatestRecommendation);
      }
    }
  }, [reducerLatestRecommendation]);
  const addEntry = (kind: TranscriptEntry["kind"], text: string): void => {
    const id = nextId.current;
    nextId.current += 1;
    setTranscript((entries) => appendEntry(entries, { id, kind, text }));
  };
  const captureRecommendation = useCallback((view: RecommendationViewModel): void => {
    if (latestRecommendationRef.current?.recommendationId === view.recommendationId) return;
    latestRecommendationRef.current = view;
    setLatestRecommendation(view);
  }, []);

  // Interim guidance (device-flow instructions) must land in the transcript.
  // A raw stderr write would tear the Ink frame it renders inside. The
  // controller delivers a `ViewModel`; route it through `renderSessionView` so
  // auth/error/device paths use interactive slash-command recovery.
  const controller = createSessionController(handlers, (received) => {
    const rendered = renderSessionView(received);
    addEntry(rendered.kind, rendered.text);
  });

  const close = (): void => {
    if (closing.current) return;
    closing.current = true;
    onExit?.();
    exit();
  };
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
    if (parsed.kind === "clear") {
      addEntry("input", commandText);
      setTranscript([]);
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
    if (admission === null) return;
    admissionSlot.current = admission.slot;
    admissionToken.current = admission.token;
    // Record the admitted command in the transcript exactly once, before
    // clearing the prompt. The parse-error / clear / exit / aborted branches
    // above already record their own input entry; a rejected overlapping
    // submission returns above this point so it never records an entry.
    // The exact recommendation accept command must remain in the typed
    // command line of the transcript — `commandText` is already the trimmed
    // raw input the user typed, so we pass it through verbatim.
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
        const rendered = renderSessionView(result.view);
        addEntry(rendered.kind, rendered.text);
        // Dispatch the matching reducer event for the captured IDs.
        // The reducer is the sole authority on auth state — the
        // component no longer carries a parallel `setAuthState` policy.
        // For `/auth status` the reducer's AUTH_FAILED path maps a
        // classified code onto `unknown(errorCode)`. For all other
        // operations OPERATION_FAILED preserves the current auth
        // (which is the connected state when auth-status already
        // succeeded) so the Find.run action remains enabled.
        if (isAuthStatus) {
          const errorCode = result.view.kind === "error" ? result.view.code : "UNKNOWN";
          dispatch({ type: "AUTH_FAILED", attemptId: capturedAttemptId, errorCode });
        } else {
          const errorCode = result.view.kind === "error" ? result.view.code : "UNKNOWN";
          dispatch({ type: "OPERATION_FAILED", operationId: capturedOperationId, errorCode });
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
              dispatch({ type: "AUTH_RESOLVED", attemptId: capturedAttemptId, detail: "EXPIRED", login: null });
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
          dispatch({ type: "OPERATION_SUCCEEDED", operationId: capturedOperationId, view: result.view });
        }
        if (result.view.kind === "recommendation") {
          captureRecommendation(result.view);
        }
      }
    } catch (error) {
      addEntry("error", formatError(error));
      if (isAuthStatus) {
        dispatch({ type: "AUTH_FAILED", attemptId: capturedAttemptId, errorCode: "UNKNOWN" });
      } else {
        dispatch({ type: "OPERATION_FAILED", operationId: capturedOperationId, errorCode: "UNKNOWN" });
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
    }
  };
  // Cancel the in-flight foreground child operation. Busy Ctrl+C must
  // abort only the current command so the session can keep accepting
 // new ones; the lifetime signal stays untouched.
  const drainQueue = async (commands: readonly string[]): Promise<void> => {
    commandQueue.current.push(...commands);
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
    () => actionsForSection(activeSectionId, authState, latestRecommendation),
    [activeSectionId, authState, latestRecommendation],
  );

  // Clamp the action cursor so it never goes out of range after auth changes.
  const clampedActionIndex =
    contextActions.length === 0
      ? -1
      : Math.min(selectedActionIndex, contextActions.length - 1);
  useInput(
    (character, key) => {
      const typed = typeof character === "string" ? character : "";
      const keyFlags = key ?? {};
      // Navigation keys (↑/↓) move focus into the sidebar from the prompt,
      // cycle categories while the sidebar has focus, and cycle actions while
      // the action panel has focus. No second key convention is introduced.
      if (keyFlags.upArrow) {
        if (focus === "actions") {
          setSelectedActionIndex((i) =>
            contextActions.length === 0
              ? 0
              : (i - 1 + contextActions.length) % contextActions.length,
          );
          return;
        }
        if (focus === "prompt") {
          setFocus("sidebar");
          setActionFocused(true);
          return;
        }
        setSelectedCategoryIndex((i) => (i - 1 + NAVIGATION_SECTIONS.length) % NAVIGATION_SECTIONS.length);
        setSelectedActionIndex(0);
        return;
      }
      if (keyFlags.downArrow) {
        if (focus === "actions") {
          setSelectedActionIndex((i) =>
            contextActions.length === 0
              ? 0
              : (i + 1) % contextActions.length,
          );
          return;
        }
        if (focus === "prompt") {
          setFocus("sidebar");
          setActionFocused(true);
          return;
        }
        setSelectedCategoryIndex((i) => (i + 1) % NAVIGATION_SECTIONS.length);
        setSelectedActionIndex(0);
        return;
      }
      // Route Ink Return (`\r`, `\n`, key.return) through focus/action
      // handling BEFORE generic prompt execution. When focus is sidebar or
      // actions the user expects Enter to fill an action, not submit the
      // (empty) prompt buffer.
      const isReturnKey =
        typed === "\r" ||
        typed === "\n" ||
        keyFlags.return === true;
      if (!isReturnKey) {
        const lineBreak = typed.search(/[\r\n]/u);
        if (lineBreak >= 0) {
          const lines = typed.split(/\r\n|\r|\n/u);
          const first = input + (lines.shift() ?? "");
          const remainder = lines.pop() ?? "";
          const commands = [first, ...lines];
          if (remainder.length > 0) setInput(remainder);
          queueMicrotask(() => {
            void drainQueue(commands);
          });
          return;
        }
      }
      const transition = sessionInputTransition(input, typed, keyFlags, busy);
      if (transition.cancel) {
        // Busy Ctrl+C aborts only the foreground child operation; the
        // session remains active so the user can run another command.
        // Idle Ctrl+C clears the prompt buffer.
        if (admissionSlot.current.running && activeOperation.current !== null) {
          activeOperation.current.controller.abort();
        }
        return;
      }
      if (transition.submit) {
        // Enter semantics depend on the active focus.
        if (focus === "actions") {
          const action = contextActions[clampedActionIndex];
          if (action !== undefined && action.availability.status === "enabled") {
            setInput(action.command);
            setFocus("prompt");
            setActionFocused(false);
          }
          // Disabled actions: leave the prompt untouched. The reason /
          // recovery text is rendered through the ContextActions panel; the
          // user reads it from the sidebar without ever calling a handler.
          return;
        }
        if (focus === "sidebar" && contextActions.length > 0) {
          setFocus("actions");
          setActionFocused(true);
          setSelectedActionIndex(0);
          return;
        }
        void submit();
        return;
      }
      setInput(transition.nextInput);
    },
    { isActive: true },
  );

  // Home key is delivered by Ink as the raw escape sequence `\x1b[H` /
  // `\x1bOH`. Listen through a second hook so the brief's "Home clears the
  // prompt and restores the dashboard" contract is honored without adding
  // a second key convention.
  useInput(
    (character) => {
      const typed = typeof character === "string" ? character : "";
      if (typed === "\u001b[H" || typed === "\u001bOH" || typed === "\u001b[1~") {
        setInput("");
        setSelectedCategoryIndex(0);
        setSelectedActionIndex(0);
        setFocus("prompt");
        setActionFocused(false);
      }
    },
    { isActive: true },
  );

  // Status string reflects the busy flag. Until Task 5 wires the auth
  // reducer into the live session, the Session surfaces a conservative
  // `Ready` placeholder so the test harness and unit suite continue to
  // observe the calm status bar; the authoritative state lives in
  // `sessionReducer` once that lands.
  const status = busy ? "Working" : "Ready";
  const sessionStatus = "active";
  // Build the structured transcript entries with plain-text row metadata
  // and criticality. The shell windows these against the row budget so a
  // long transcript never blows past `capabilities.rows` and critical
  // entries (verification URI, recommendation ID, typed command, auth
  // recovery line) survive older noncritical fillers.
  const renderableEntries = useMemo<readonly RenderableTranscriptEntry[]>(() => {
    const width = capabilities.columns;
    const base: RenderableTranscriptEntry[] = transcript.map((entry) => {
      const criticality = isCriticalTranscriptText(entry.text, input)
        ? "critical"
        : "noncritical";
      return {
        id: entry.id,
        text: entry.text,
        kind: entry.kind,
        criticality,
        rows: estimateEntryRows(entry.text, entry.kind, width),
      };
    });
    // Mirror the original Session fallback: when the transcript is just
    // the welcome-back system entry, surface the `Try /help` hint as a
    // noncritical filler so the calm status bar still nudges the user.
    if (transcript.length === 1 && transcript[0]?.kind === "system") {
      base.push({
        id: -1,
        text: HELP_TEXT,
        kind: "output",
        criticality: "noncritical",
        rows: estimateEntryRows(HELP_TEXT, "output", width),
      });
    }
    return base;
  }, [transcript, capabilities.columns, input]);
  return (
    <DashboardShell
      status={status}
      title="Mission Control"
      subtitle="Welcome back"
      sessionStatus={sessionStatus}
      mission={{
        title: "No active mission",
        description: "Discover a challenge or resume your current engineering work.",
        suggestions: DEFAULT_MISSION_SUGGESTIONS,
      }}
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
      actionFocused={actionFocused}
      entries={renderableEntries}
    />
  );
}
