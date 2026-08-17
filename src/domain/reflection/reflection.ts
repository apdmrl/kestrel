import type { DomainResult } from "../shared/result.js";
import { err, ok } from "../shared/result.js";

/** Structured, optional mission reflection. Never blocks completion. */
export interface Reflection {
  readonly initialHypothesis: string | undefined;
  readonly finalUnderstanding: string | undefined;
  readonly unexpectedFinding: string | undefined;
  readonly lesson: string | undefined;
  readonly notes: string | undefined;
}

export interface CreateReflectionInput {
  readonly initialHypothesis?: string;
  readonly finalUnderstanding?: string;
  readonly unexpectedFinding?: string;
  readonly lesson?: string;
  readonly notes?: string;
}

export function createReflection(input: CreateReflectionInput): DomainResult<Reflection> {
  const fields = [
    input.initialHypothesis,
    input.finalUnderstanding,
    input.unexpectedFinding,
    input.lesson,
    input.notes,
  ];
  const hasContent = fields.some((value) => value !== undefined && value.trim().length > 0);
  if (!hasContent) {
    return err("DM_INVALID_REFLECTION", "a reflection must contain at least one field");
  }
  return ok({
    initialHypothesis: input.initialHypothesis,
    finalUnderstanding: input.finalUnderstanding,
    unexpectedFinding: input.unexpectedFinding,
    lesson: input.lesson,
    notes: input.notes,
  });
}
