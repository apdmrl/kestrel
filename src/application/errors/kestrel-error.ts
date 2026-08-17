import type {
  ErrorCategory,
  ErrorCode,
  RecoveryStrategy,
  Retryability,
  Severity,
} from "./error-codes.js";
import { isRecoverableCategory } from "./error-codes.js";

const SECRET_KEY = /token|authorization|password|secret/i;

/** Recursively replace values at secret-shaped keys with a redaction marker. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      output[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redactSecrets(entry);
    }
    return output;
  }
  return value;
}

export interface KestrelErrorInit {
  code: ErrorCode;
  category: ErrorCategory;
  userMessage: string;
  suggestedActions?: readonly string[];
  retryability: Retryability;
  recoveryStrategy: RecoveryStrategy;
  severity: Severity;
  cause?: unknown;
  debugContext?: unknown;
}

/** A classified, recovery-oriented application error. Raw exceptions never cross this boundary. */
export class KestrelError extends Error {
  readonly code: ErrorCode;
  readonly category: ErrorCategory;
  readonly userMessage: string;
  readonly suggestedActions: readonly string[];
  readonly retryability: Retryability;
  readonly recoveryStrategy: RecoveryStrategy;
  readonly severity: Severity;
  readonly debugContext?: unknown;

  private constructor(init: KestrelErrorInit) {
    const causeOptions = init.cause === undefined ? undefined : { cause: init.cause };
    super(init.userMessage, causeOptions);
    this.name = "KestrelError";
    this.code = init.code;
    this.category = init.category;
    this.userMessage = init.userMessage;
    this.suggestedActions = init.suggestedActions ?? [];
    this.retryability = init.retryability;
    this.recoveryStrategy = init.recoveryStrategy;
    this.severity = init.severity;
    if (init.debugContext !== undefined) {
      this.debugContext = redactSecrets(init.debugContext);
    }
  }

  static create(init: KestrelErrorInit): KestrelError {
    if (init.userMessage.trim().length === 0) {
      throw new Error("KestrelError requires a non-empty userMessage");
    }
    if (isRecoverableCategory(init.category)) {
      const actions = init.suggestedActions ?? [];
      if (actions.length === 0 || actions.some((action) => action.trim().length === 0)) {
        throw new Error(
          "KestrelError: recoverable errors require at least one non-empty suggested action",
        );
      }
    }
    return new KestrelError(init);
  }
}

/** Convenience factory; the only supported way to construct a classified error. */
export function createKestrelError(init: KestrelErrorInit): KestrelError {
  return KestrelError.create(init);
}

/** Type guard so presentation can serialize a classified error without re-throwing. */
export function isKestrelError(value: unknown): value is KestrelError {
  return value instanceof KestrelError;
}
