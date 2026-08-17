import type { DomainResult } from "../shared/result.js";
import { err, ok } from "../shared/result.js";
import type { IsoDateTime } from "../shared/time.js";

/**
 * Time-sensitive repository/issue observations, kept separate from immutable
 * Challenge truth. These values may be cached with different TTLs.
 */
export interface EvaluationContext {
  readonly observedAt: IsoDateTime;
  readonly repositoryHealth: number | undefined;
  readonly repositoryInterest: number | undefined;
  readonly contributionGuide: boolean | undefined;
  readonly competingWork: number | undefined;
  readonly maintainerActivity: number | undefined;
  readonly issueQuality: number | undefined;
  readonly confidence: number;
}

export interface CreateEvaluationContextInput {
  readonly observedAt: IsoDateTime;
  readonly repositoryHealth?: number;
  readonly repositoryInterest?: number;
  readonly contributionGuide?: boolean;
  readonly competingWork?: number;
  readonly maintainerActivity?: number;
  readonly issueQuality?: number;
  readonly confidence: number;
}

function isUnit(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

export function createEvaluationContext(
  input: CreateEvaluationContextInput,
): DomainResult<EvaluationContext> {
  if (!isUnit(input.confidence)) {
    return err("DM_INVALID_CONTEXT", "confidence must be between 0 and 1");
  }
  const bounded = [
    ["repositoryHealth", input.repositoryHealth],
    ["repositoryInterest", input.repositoryInterest],
    ["maintainerActivity", input.maintainerActivity],
    ["issueQuality", input.issueQuality],
  ] as const;
  for (const [name, value] of bounded) {
    if (value !== undefined && !isUnit(value)) {
      return err("DM_INVALID_CONTEXT", `${name} must be between 0 and 1`);
    }
  }
  if (
    input.competingWork !== undefined &&
    (!Number.isInteger(input.competingWork) || input.competingWork < 0)
  ) {
    return err("DM_INVALID_CONTEXT", "competingWork must be a non-negative integer");
  }
  return ok({
    observedAt: input.observedAt,
    repositoryHealth: input.repositoryHealth,
    repositoryInterest: input.repositoryInterest,
    contributionGuide: input.contributionGuide,
    competingWork: input.competingWork,
    maintainerActivity: input.maintainerActivity,
    issueQuality: input.issueQuality,
    confidence: input.confidence,
  });
}
