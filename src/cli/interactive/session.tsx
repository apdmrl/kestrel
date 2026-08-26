import { Box, Text, useApp, useInput } from "ink";
import { useRef, useState } from "react";
import type { CommandHandlers } from "../command-handlers.js";
import { createSessionController } from "./session-controller.js";
import { parseSessionCommand, SessionParseError } from "./session-parser.js";
import type { TranscriptEntry } from "./session-view-models.js";

const MAX_TRANSCRIPT_ENTRIES = 200;
const HELP_TEXT = "Try /help for commands · /find to discover a challenge";

export interface SessionProps {
  readonly handlers: CommandHandlers;
  readonly signal: AbortSignal;
  readonly onExit?: () => void;
  readonly onCancel?: () => void;
}

export interface SessionInputKey {
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly return?: boolean;
  readonly backspace?: boolean;
  readonly delete?: boolean;
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

export function Session({ handlers, signal, onExit, onCancel }: SessionProps) {
  const { exit } = useApp();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const nextId = useRef(2);
  const closing = useRef(false);
  const [transcript, setTranscript] = useState<readonly TranscriptEntry[]>([
    { id: 1, kind: "system", text: "✓ Welcome back\n  Type /help to see commands." },
  ]);
  const commandQueue = useRef<string[]>([]);
  const drainingQueue = useRef(false);

  const addEntry = (kind: TranscriptEntry["kind"], text: string): void => {
    const id = nextId.current;
    nextId.current += 1;
    setTranscript((entries) => appendEntry(entries, { id, kind, text }));
  };

  // Interim guidance (device-flow instructions) must land in the transcript.
  // A raw stderr write would tear the Ink frame it renders inside.
  const controller = createSessionController(handlers, (text) => addEntry("output", text));

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
      const result = await controller(parsed);
      if (result.kind === "clear") {
        setTranscript([]);
      } else if (result.kind === "exit") {
        close();
      } else if (result.kind === "error") {
        addEntry("error", result.text);
      } else {
        addEntry("output", result.text);
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

  useInput(
    (character, key) => {
      const typed = typeof character === "string" ? character : "";
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
      const transition = sessionInputTransition(input, typed, key ?? {}, busy);
      if (transition.cancel) {
        onCancel?.();
      } else if (transition.submit) {
        void submit();
      } else {
        setInput(transition.nextInput);
      }
    },
    { isActive: true },
  );

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text color="white" bold>
          KESTREL
        </Text>
        <Text color="gray">LOCAL WORKSPACE · {busy ? "Working" : "Ready"}</Text>
      </Box>
      {transcript.map((entry) => (
        <TranscriptLine key={entry.id} entry={entry} />
      ))}
      {transcript.length === 1 && transcript[0]?.kind === "system" ? (
        <Text color="gray">{HELP_TEXT}</Text>
      ) : null}
      <Box marginTop={1}>
        <Text color="cyan">› </Text>
        <Text color="white">{input}</Text>
        {busy ? <Text color="yellow"> Working… (Ctrl+C to cancel)</Text> : null}
      </Box>
    </Box>
  );
}
