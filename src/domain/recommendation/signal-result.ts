import type { DomainResult } from "../shared/result.js";
import { err, ok } from "../shared/result.js";

/** A single explainable, numeric contribution from one recommendation signal evaluator. */
export interface SignalResult {
  readonly name: string;
  readonly value: number;
  readonly confidence: number;
  readonly reason: string;
}

export interface CreateSignalResultInput {
  readonly name: string;
  readonly value: number;
  readonly confidence: number;
  readonly reason: string;
}

function isUnit(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

export function createSignalResult(input: CreateSignalResultInput): DomainResult<SignalResult> {
  if (input.name.trim().length === 0) {
    return err("DM_INVALID_SIGNAL", "signal name must not be empty");
  }
  if (!isUnit(input.value)) {
    return err("DM_INVALID_SIGNAL", "signal value must be between 0 and 1");
  }
  if (!isUnit(input.confidence)) {
    return err("DM_INVALID_SIGNAL", "signal confidence must be between 0 and 1");
  }
  if (input.reason.trim().length === 0) {
    return err("DM_INVALID_SIGNAL", "signal reason must not be empty");
  }
  return ok({
    name: input.name,
    value: input.value,
    confidence: input.confidence,
    reason: input.reason,
  });
}
