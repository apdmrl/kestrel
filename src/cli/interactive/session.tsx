import { Box, Text, useApp, useInput } from "ink";
import { useState } from "react";
import type { CommandHandlers } from "../command-handlers.js";
import { createSessionController } from "./session-controller.js";
import { parseSessionCommand, SessionParseError } from "./session-parser.js";
import type { TranscriptEntry } from "./session-view-models.js";

const MAX_TRANSCRIPT_ENTRIES = 200;
const HELP_TEXT = "/help  /clear  /exit\n/find  /mission current  /mission ...\n/progress  /journey  /preferences ...";

export interface SessionProps {
  readonly handlers: CommandHandlers;
  readonly signal: AbortSignal;
  readonly onExit?: () => void;
}

function appendEntry(entries: readonly TranscriptEntry[], entry: TranscriptEntry): readonly TranscriptEntry[] {
  const next = [...entries, entry];
  return next.length > MAX_TRANSCRIPT_ENTRIES ? next.slice(-MAX_TRANSCRIPT_ENTRIES) : next;
}

export function Session({ handlers, signal, onExit }: SessionProps) {
  const { exit } = useApp();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [nextId, setNextId] = useState(2);
  const [transcript, setTranscript] = useState<readonly TranscriptEntry[]>([
    { id: 1, kind: "system", text: "✓ Welcome back\n  Type /help to see commands." },
  ]);
  const controller = createSessionController(handlers);

  const addEntry = (kind: TranscriptEntry["kind"], text: string): void => {
    setTranscript((entries) => appendEntry(entries, { id: nextId, kind, text }));
    setNextId((id) => id + 1);
  };

  const close = (): void => {
    onExit?.();
    exit();
  };

  const submit = async (): Promise<void> => {
    const commandText = input.trim();
    if (commandText.length === 0 || busy) return;
    setInput("");
    addEntry("input", `kestrel › ${commandText}`);
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
        addEntry("error", `× ${result.text}`);
      } else {
        addEntry("output", result.text);
      }
    } finally {
      setBusy(false);
    }
  };

  useInput((character, key) => {
    if (key.ctrl && character === "c") {
      setInput("");
      return;
    }
    if (character === "\r" || character === "\n" || key.return) {
      void submit();
      return;
    }
    if (key.backspace || key.delete) {
      setInput((value) => value.slice(0, -1));
      return;
    }
    if (!key.ctrl && !key.meta && character.length > 0) {
      setInput((value) => value + character);
    }
  }, { isActive: !busy });

  return (
    <Box flexDirection="column">
      <Text color="greenBright"> KESTREL  /  LOCAL ENGINEERING COMPANION</Text>
      <Text color="green"> workspace: local                              session: {busy ? "working" : "ready"}</Text>
      {transcript.map((entry) => (
        <Text key={entry.id} color={entry.kind === "error" ? "red" : entry.kind === "input" ? "greenBright" : "green"}>
          {entry.text}
        </Text>
      ))}
      <Text color="greenBright">kestrel › {input}{busy ? " …" : ""}</Text>
      {transcript.length === 1 && transcript[0]?.kind === "system" ? <Text color="green">{HELP_TEXT}</Text> : null}
    </Box>
  );
}
