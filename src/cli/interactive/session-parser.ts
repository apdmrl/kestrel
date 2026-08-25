export type SessionCommand =
  | { readonly kind: "help" }
  | { readonly kind: "clear" }
  | { readonly kind: "exit" }
  | { readonly kind: "find"; readonly mood: string; readonly type?: string }
  | { readonly kind: "mission-current"; readonly missionId?: string }
  | { readonly kind: "mission-accept"; readonly recommendationId: string }
  | { readonly kind: "mission-prepare"; readonly missionId?: string }
  | { readonly kind: "mission-resume"; readonly missionId?: string }
  | { readonly kind: "mission-complete"; readonly missionId?: string }
  | { readonly kind: "mission-abandon"; readonly missionId?: string; readonly reason: string }
  | { readonly kind: "mission-break-lock"; readonly missionId: string }
  | { readonly kind: "agent-brief"; readonly missionId?: string; readonly hypothesis?: string }
  | { readonly kind: "verify-submission"; readonly missionId?: string; readonly prNumber: number }
  | { readonly kind: "verify-link"; readonly missionId?: string; readonly prNumber: number }
  | { readonly kind: "verify-merge"; readonly missionId?: string; readonly prNumber: number }
  | { readonly kind: "journey" }
  | { readonly kind: "progress" }
  | { readonly kind: "preferences-get" }
  | { readonly kind: "preferences-set"; readonly language?: string; readonly mode?: string };

export class SessionParseError extends Error {
  readonly usage?: string;

  constructor(message: string, usage?: string) {
    super(message);
    this.name = "SessionParseError";
    this.usage = usage;
  }
}

type TokenResult = { readonly tokens: readonly string[] } | SessionParseError;

function tokenize(input: string): TokenResult {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let tokenStarted = false;
  let tokenQuoted = false;

  const push = (): void => {
    if (tokenStarted) {
      tokens.push(tokenQuoted && token.startsWith("--") ? `\u0000${token}` : token);
      token = "";
      tokenStarted = false;
      tokenQuoted = false;
    }
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      } else {
        token += character;
      }
      tokenStarted = true;
    } else if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
      tokenQuoted = true;
    } else if (/\s/u.test(character)) {
      push();
    } else {
      token += character;
      tokenStarted = true;
    }
  }

  if (quote !== undefined) {
    return new SessionParseError("Unterminated quote in command input");
  }
  push();
  return { tokens };
}

function options(tokens: readonly string[]): Map<string, string> | SessionParseError {
  const values = new Map<string, string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const option = tokens[index];
    if (!option.startsWith("--")) {
      return new SessionParseError(`Unexpected argument: ${option}`);
    }
    const value = tokens[index + 1];
    if (value === undefined || (value.startsWith("--") && !value.startsWith("\u0000"))) {
      return new SessionParseError(`Missing value for ${option}`);
    }
    if (values.has(option)) {
      return new SessionParseError(`Duplicate option: ${option}`);
    }
    values.set(option, value.startsWith("\u0000") ? value.slice(1) : value);
    index += 1;
  }
  return values;
}

function optional(values: Map<string, string>, name: string): string | undefined {
  return values.get(name);
}

function required(values: Map<string, string>, name: string): string | SessionParseError {
  const value = values.get(name);
  return value === undefined ? new SessionParseError(`Missing required option ${name}`) : value;
}

function rejectUnknown(values: Map<string, string>, allowed: readonly string[]): SessionParseError | undefined {
  for (const key of values.keys()) {
    if (!allowed.includes(key)) {
      return new SessionParseError(`Unknown option: ${key}`);
    }
  }
  return undefined;
}

function numeric(value: string, option: string): number | SessionParseError {
  const number = Number(value);
  return Number.isInteger(number) && number > 0
    ? number
    : new SessionParseError(`Invalid value for ${option}: ${value}`);
}

function parseMission(tokens: readonly string[]): SessionCommand | SessionParseError {
  const action = tokens[0];
  if (action === undefined) return new SessionParseError("Missing mission action");
  const parsed = options(tokens.slice(1));
  if (parsed instanceof SessionParseError) return parsed;

  switch (action) {
    case "current": {
      const unknown = rejectUnknown(parsed, ["--id"]);
      return unknown ?? { kind: "mission-current", ...(optional(parsed, "--id") !== undefined ? { missionId: optional(parsed, "--id") } : {}) };
    }
    case "accept": {
      const unknown = rejectUnknown(parsed, ["--id"]);
      if (unknown !== undefined) return unknown;
      const id = required(parsed, "--id");
      return id instanceof SessionParseError ? id : { kind: "mission-accept", recommendationId: id };
    }
    case "prepare":
    case "resume":
    case "complete": {
      const unknown = rejectUnknown(parsed, ["--id"]);
      if (unknown !== undefined) return unknown;
      const missionId = optional(parsed, "--id");
      return { kind: `mission-${action}`, ...(missionId !== undefined ? { missionId } : {}) } as SessionCommand;
    }
    case "abandon": {
      const unknown = rejectUnknown(parsed, ["--id", "--reason"]);
      if (unknown !== undefined) return unknown;
      const reason = required(parsed, "--reason");
      return reason instanceof SessionParseError
        ? reason
        : { kind: "mission-abandon", reason, ...(optional(parsed, "--id") !== undefined ? { missionId: optional(parsed, "--id") } : {}) };
    }
    case "break-lock": {
      const unknown = rejectUnknown(parsed, ["--id"]);
      if (unknown !== undefined) return unknown;
      const missionId = required(parsed, "--id");
      return missionId instanceof SessionParseError ? missionId : { kind: "mission-break-lock", missionId };
    }
    default:
      return new SessionParseError(`Unknown mission action: ${action}`);
  }
}

export function parseSessionCommand(input: string): SessionCommand | SessionParseError {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return new SessionParseError(`Commands must start with \`/\`; try /${trimmed || "help"}`);
  }
  const tokenResult = tokenize(trimmed);
  if (tokenResult instanceof SessionParseError) return tokenResult;
  const [command, ...args] = tokenResult.tokens;
  if (command === undefined) return new SessionParseError("Missing command; try /help");

  switch (command.slice(1)) {
    case "help":
      return args.length === 0 ? { kind: "help" } : new SessionParseError("/help takes no options");
    case "clear":
      return args.length === 0 ? { kind: "clear" } : new SessionParseError("/clear takes no options");
    case "exit":
    case "quit":
      return args.length === 0 ? { kind: "exit" } : new SessionParseError("/exit takes no options");
    case "progress":
      return args.length === 0 ? { kind: "progress" } : new SessionParseError("/progress takes no options");
    case "journey":
      return args.length === 0 ? { kind: "journey" } : new SessionParseError("/journey takes no options");
    case "find": {
      const parsed = options(args);
      if (parsed instanceof SessionParseError) return parsed;
      const unknown = rejectUnknown(parsed, ["--mood", "--type"]);
      return unknown ?? { kind: "find", mood: optional(parsed, "--mood") ?? "QUICK_WIN", ...(optional(parsed, "--type") !== undefined ? { type: optional(parsed, "--type") } : {}) };
    }
    case "mission":
      return parseMission(args);
    case "agent": {
      if (args[0] !== "brief") return new SessionParseError(`Unknown agent action: ${args[0] ?? ""}`);
      const parsed = options(args.slice(1));
      if (parsed instanceof SessionParseError) return parsed;
      const unknown = rejectUnknown(parsed, ["--id", "--hypothesis"]);
      if (unknown !== undefined) return unknown;
      return {
        kind: "agent-brief",
        ...(optional(parsed, "--id") !== undefined ? { missionId: optional(parsed, "--id") } : {}),
        ...(optional(parsed, "--hypothesis") !== undefined ? { hypothesis: optional(parsed, "--hypothesis") } : {}),
      };
    }
    case "verify": {
      const action = args[0];
      if (action !== "submission" && action !== "link" && action !== "merge") {
        return new SessionParseError(`Unknown verify action: ${action ?? ""}`);
      }
      const parsed = options(args.slice(1));
      if (parsed instanceof SessionParseError) return parsed;
      const unknown = rejectUnknown(parsed, ["--id", "--pr"]);
      if (unknown !== undefined) return unknown;
      const pr = required(parsed, "--pr");
      if (pr instanceof SessionParseError) return pr;
      const prNumber = numeric(pr, "--pr");
      if (prNumber instanceof SessionParseError) return prNumber;
      return { kind: `verify-${action}`, prNumber, ...(optional(parsed, "--id") !== undefined ? { missionId: optional(parsed, "--id") } : {}) } as SessionCommand;
    }
    case "preferences": {
      const action = args[0];
      if (action === "get") return args.length === 1 ? { kind: "preferences-get" } : new SessionParseError("/preferences get takes no options");
      if (action !== "set") return new SessionParseError(`Unknown preferences action: ${action ?? ""}`);
      const parsed = options(args.slice(1));
      if (parsed instanceof SessionParseError) return parsed;
      const unknown = rejectUnknown(parsed, ["--language", "--mode"]);
      return unknown ?? { kind: "preferences-set", ...(optional(parsed, "--language") !== undefined ? { language: optional(parsed, "--language") } : {}), ...(optional(parsed, "--mode") !== undefined ? { mode: optional(parsed, "--mode") } : {}) };
    }
    default:
      return new SessionParseError(`Unknown command: ${command}`);
  }
}
