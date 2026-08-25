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
  readonly usage: string | undefined;

  constructor(message: string, usage?: string) {
    super(message);
    this.name = "SessionParseError";
    this.usage = usage;
  }
}

type Token = {
  readonly value: string;
  readonly quotedLeadingDashes: boolean;
};

type TokenResult = { readonly tokens: readonly Token[] } | SessionParseError;

function tokenize(input: string): TokenResult {
  const tokens: Token[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let tokenStarted = false;
  let quotedLeadingDashCount = 0;

  const push = (): void => {
    if (tokenStarted) {
      tokens.push({
        value: token,
        quotedLeadingDashes: token.startsWith("--") && quotedLeadingDashCount === 2,
      });
      token = "";
      tokenStarted = false;
      quotedLeadingDashCount = 0;
    }
  };
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      } else {
        if (character === "-" && token.length < 2) quotedLeadingDashCount += 1;
        token += character;
      }
      tokenStarted = true;
    } else if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
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

function options(tokens: readonly Token[]): Map<string, string> | SessionParseError {
  const values = new Map<string, string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const option = tokens[index]!;
    if (!option.value.startsWith("--")) {
      return new SessionParseError(`Unexpected argument: ${option.value}`);
    }
    const value = tokens[index + 1];
    if (value === undefined || (value.value.startsWith("--") && !value.quotedLeadingDashes)) {
      return new SessionParseError(`Missing value for ${option.value}`);
    }
    if (values.has(option.value)) {
      return new SessionParseError(`Duplicate option: ${option.value}`);
    }
    values.set(option.value, value.value);
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

function rejectUnknown(
  values: Map<string, string>,
  allowed: readonly string[],
): SessionParseError | undefined {
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

function parseMission(tokens: readonly Token[]): SessionCommand | SessionParseError {
  const actionToken = tokens[0];
  if (actionToken === undefined) return new SessionParseError("Missing mission action");
  const action = actionToken.value;
  const parsed = options(tokens.slice(1));
  if (parsed instanceof SessionParseError) return parsed;

  switch (action) {
    case "current": {
      const unknown = rejectUnknown(parsed, ["--id"]);
      if (unknown !== undefined) return unknown;
      const missionId = optional(parsed, "--id");
      return missionId === undefined
        ? { kind: "mission-current" }
        : { kind: "mission-current", missionId };
    }
    case "accept": {
      const unknown = rejectUnknown(parsed, ["--id"]);
      if (unknown !== undefined) return unknown;
      const id = required(parsed, "--id");
      return id instanceof SessionParseError
        ? id
        : { kind: "mission-accept", recommendationId: id };
    }
    case "prepare":
    case "resume":
    case "complete": {
      const unknown = rejectUnknown(parsed, ["--id"]);
      if (unknown !== undefined) return unknown;
      const missionId = optional(parsed, "--id");
      return missionId === undefined
        ? { kind: `mission-${action}` as "mission-prepare" | "mission-resume" | "mission-complete" }
        : {
            kind: `mission-${action}` as "mission-prepare" | "mission-resume" | "mission-complete",
            missionId,
          };
    }
    case "abandon": {
      const unknown = rejectUnknown(parsed, ["--id", "--reason"]);
      if (unknown !== undefined) return unknown;
      const reason = required(parsed, "--reason");
      if (reason instanceof SessionParseError) return reason;
      const missionId = optional(parsed, "--id");
      return missionId === undefined
        ? { kind: "mission-abandon", reason }
        : { kind: "mission-abandon", reason, missionId };
    }
    case "break-lock": {
      const unknown = rejectUnknown(parsed, ["--id"]);
      if (unknown !== undefined) return unknown;
      const missionId = required(parsed, "--id");
      return missionId instanceof SessionParseError
        ? missionId
        : { kind: "mission-break-lock", missionId };
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
  const [commandToken, ...args] = tokenResult.tokens;
  if (commandToken === undefined) return new SessionParseError("Missing command; try /help");
  const command = commandToken.value;

  switch (command.slice(1)) {
    case "help":
      return args.length === 0 ? { kind: "help" } : new SessionParseError("/help takes no options");
    case "clear":
      return args.length === 0
        ? { kind: "clear" }
        : new SessionParseError("/clear takes no options");
    case "exit":
    case "quit":
      return args.length === 0 ? { kind: "exit" } : new SessionParseError("/exit takes no options");
    case "progress":
      return args.length === 0
        ? { kind: "progress" }
        : new SessionParseError("/progress takes no options");
    case "journey":
      return args.length === 0
        ? { kind: "journey" }
        : new SessionParseError("/journey takes no options");
    case "find": {
      const parsed = options(args);
      if (parsed instanceof SessionParseError) return parsed;
      const unknown = rejectUnknown(parsed, ["--mood", "--type"]);
      if (unknown !== undefined) return unknown;
      const mood = optional(parsed, "--mood") ?? "QUICK_WIN";
      const type = optional(parsed, "--type");
      return type === undefined ? { kind: "find", mood } : { kind: "find", mood, type };
    }
    case "mission":
      return parseMission(args);
    case "agent": {
      if (args[0]?.value !== "brief")
        return new SessionParseError(`Unknown agent action: ${args[0]?.value ?? ""}`);
      const parsed = options(args.slice(1));
      if (parsed instanceof SessionParseError) return parsed;
      const unknown = rejectUnknown(parsed, ["--id", "--hypothesis"]);
      if (unknown !== undefined) return unknown;
      const missionId = optional(parsed, "--id");
      const hypothesis = optional(parsed, "--hypothesis");
      if (missionId === undefined) {
        return hypothesis === undefined
          ? { kind: "agent-brief" }
          : { kind: "agent-brief", hypothesis };
      }
      if (hypothesis === undefined) return { kind: "agent-brief", missionId };
      return { kind: "agent-brief", missionId, hypothesis };
    }
    case "verify": {
      const action = args[0]?.value;
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
      const missionId = optional(parsed, "--id");
      if (action === "submission") {
        return missionId === undefined
          ? { kind: "verify-submission", prNumber }
          : { kind: "verify-submission", prNumber, missionId };
      }
      if (action === "link") {
        return missionId === undefined
          ? { kind: "verify-link", prNumber }
          : { kind: "verify-link", prNumber, missionId };
      }
      return missionId === undefined
        ? { kind: "verify-merge", prNumber }
        : { kind: "verify-merge", prNumber, missionId };
    }
    case "preferences": {
      const action = args[0]?.value;
      if (action === "get")
        return args.length === 1
          ? { kind: "preferences-get" }
          : new SessionParseError("/preferences get takes no options");
      if (action !== "set")
        return new SessionParseError(`Unknown preferences action: ${action ?? ""}`);
      const parsed = options(args.slice(1));
      if (parsed instanceof SessionParseError) return parsed;
      const unknown = rejectUnknown(parsed, ["--language", "--mode"]);
      if (unknown !== undefined) return unknown;
      const language = optional(parsed, "--language");
      const mode = optional(parsed, "--mode");
      if (language === undefined) {
        return mode === undefined ? { kind: "preferences-set" } : { kind: "preferences-set", mode };
      }
      if (mode === undefined) return { kind: "preferences-set", language };
      return { kind: "preferences-set", language, mode };
    }
    default:
      return new SessionParseError(`Unknown command: ${command}`);
  }
}
