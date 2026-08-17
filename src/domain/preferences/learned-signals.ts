import type { DomainResult } from "../shared/result.js";
import { err, ok } from "../shared/result.js";

/** What Kestrel infers from behavior. Always a signal, never a declared preference. */
export interface LearnedSignals {
  readonly languageAffinity: Readonly<Record<string, number>>;
  readonly missionTypeAffinity: Readonly<Record<string, number>>;
  readonly interestAffinity: Readonly<Record<string, number>>;
  readonly scopeAffinity: Readonly<Record<string, number>>;
  readonly recentPatterns: readonly string[];
}

export interface CreateLearnedSignalsInput {
  readonly languageAffinity?: Readonly<Record<string, number>>;
  readonly missionTypeAffinity?: Readonly<Record<string, number>>;
  readonly interestAffinity?: Readonly<Record<string, number>>;
  readonly scopeAffinity?: Readonly<Record<string, number>>;
  readonly recentPatterns?: readonly string[];
}

function isUnit(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function validateAffinities(
  label: string,
  values: Readonly<Record<string, number>> | undefined,
): DomainResult<Readonly<Record<string, number>>> {
  const record = values ?? {};
  for (const [key, value] of Object.entries(record)) {
    if (!isUnit(value)) {
      return err("DM_INVALID_AFFINITY", `${label} affinity for "${key}" must be between 0 and 1`);
    }
  }
  return ok({ ...record });
}

function dedupe(values: readonly string[] | undefined): readonly string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const raw of values ?? []) {
    const trimmed = raw.trim();
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      output.push(trimmed);
    }
  }
  return output;
}

export function createLearnedSignals(
  input: CreateLearnedSignalsInput,
): DomainResult<LearnedSignals> {
  const languageAffinity = validateAffinities("language", input.languageAffinity);
  if (!languageAffinity.ok) {
    return languageAffinity;
  }
  const missionTypeAffinity = validateAffinities("mission type", input.missionTypeAffinity);
  if (!missionTypeAffinity.ok) {
    return missionTypeAffinity;
  }
  const interestAffinity = validateAffinities("interest", input.interestAffinity);
  if (!interestAffinity.ok) {
    return interestAffinity;
  }
  const scopeAffinity = validateAffinities("scope", input.scopeAffinity);
  if (!scopeAffinity.ok) {
    return scopeAffinity;
  }
  return ok({
    languageAffinity: languageAffinity.value,
    missionTypeAffinity: missionTypeAffinity.value,
    interestAffinity: interestAffinity.value,
    scopeAffinity: scopeAffinity.value,
    recentPatterns: dedupe(input.recentPatterns),
  });
}
