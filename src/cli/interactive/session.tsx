import { Box, Text, useApp, useInput } from "ink";
import { useCallback, useMemo, useRef, useState } from "react";
import type { CommandHandlers } from "../command-handlers.js";
import type { RecommendationViewModel } from "../presentation/view-models.js";
import { createSessionController } from "./session-controller.js";
import {
  DashboardShell,
  DEFAULT_MISSION_SUGGESTIONS,
  DEFAULT_QUICK_COMMANDS,
  type TerminalCapabilities,
} from "./dashboard.js";
import { actionsForSection, NAVIGATION_SECTIONS } from "./session-navigation.js";
import { parseSessionCommand, SessionParseError } from "./session-parser.js";
import { renderSessionView } from "./session-renderer.js";
import type { SessionAuthState } from "./session-state.js";
import type { TranscriptEntry } from "./session-view-models.js";

const MAX_TRANSCRIPT_ENTRIES = 200;
const HELP_TEXT = "Try /help for commands · /find to discover a challenge";
const FALLBACK_CAPABILITIES: TerminalCapabilities = { columns: 80, rows: 24, color: true };
const PROMPT_PLACEHOLDER = "Type a command…";

export interface SessionProps {
  readonly handlers: CommandHandlers;
  readonly signal: AbortSignal;
  readonly onExit?: () => void;
  readonly onCancel?: () => void;
  /**
   * Test-injected terminal capabilities. Until Task 5 wires `useStdout`,
   * the runtime session reads capabilities from `process.stdout`; this prop
   * is the conservative 80x24 fallback so `ink-testing-library` and the
   * session-auth harness can mount the shell deterministically.
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
  onCancel,
  capabilities = FALLBACK_CAPABILITIES,
  initialInput = "",
  initialCategory,
  latestRecommendation: latestRecommendationProp = null,
}: SessionProps) {
  const { exit } = useApp();
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
  const [latestRecommendation, setLatestRecommendation] =
    useState<RecommendationViewModel | null>(latestRecommendationProp);
  // The controller reports `latestRecommendation` via `OPERATION_SUCCEEDED`
  // through the reducer; until that wiring lands we capture the value from
  // the controller's `notify` channel and from successful controller results.
  const latestRecommendationRef = useRef<RecommendationViewModel | null>(latestRecommendationProp);
  const [authState, setAuthState] = useState<SessionAuthState>({
    status: "checking",
    attemptId: 1,
  });

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
    const commandText = (commandOverride ?? input).trim();
    if (commandText.length === 0 || busy || closing.current) return;
    setInput("");
    addEntry("input", commandText);
    const parsed = parseSessionCommand(commandText);
    if (parsed instanceof SessionParseError) {
      addEntry("error", `! ${parsed.message}`);
      return;
    }
    if (parsed.kind === "clear") {
      setTranscript([]);
      return;
    }
    if (parsed.kind === "exit") {
      close();
      return;
    }
    if (signal.aborted) {
      addEntry("error", "! Operation cancelled");
      return;
    }
    setBusy(true);
    try {
      const result = await controller(parsed, { signal });
      if (result.kind === "clear") {
        setTranscript([]);
      } else if (result.kind === "exit") {
        close();
      } else if (result.kind === "error") {
        const rendered = renderSessionView(result.view);
        addEntry(rendered.kind, rendered.text);
      } else {
        const rendered = renderSessionView(result.view);
        addEntry(rendered.kind, rendered.text);
        // Mirror the controller's authoritative auth status into the live
        // auth state so the contextual action panel reflects the same view
        // the renderer just displayed. The controller's `auth-status`
        // result is the single source of truth; we don't introduce a
        // second policy.
        if (result.view.kind === "auth-status") {
          if (result.view.connected && result.view.login !== null) {
            setAuthState({ status: "connected", login: result.view.login });
          } else if (result.view.detail === "EXPIRED") {
            setAuthState({ status: "expired" });
          } else {
            setAuthState({ status: "required" });
          }
        }
        if (result.view.kind === "recommendation") {
          captureRecommendation(result.view);
        }
      }
    } catch (error) {
      addEntry("error", formatError(error));
    } finally {
      setBusy(false);
    }
  };
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
        onCancel?.();
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
    >
      {transcript.map((entry) => (
        <TranscriptLine key={entry.id} entry={entry} />
      ))}
      {transcript.length === 1 && transcript[0]?.kind === "system" ? (
        <Text color="gray">{HELP_TEXT}</Text>
      ) : null}
    </DashboardShell>
  );
}
