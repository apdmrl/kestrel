import type { DomainResult } from "../shared/result.js";
import { ok } from "../shared/result.js";
import type { ChallengeType } from "../challenge/challenge.js";
import type { LearnedSignals } from "./learned-signals.js";

export type DeveloperMode = "GUIDED" | "EXPERT";
export type Difficulty = "BEGINNER" | "INTERMEDIATE" | "ADVANCED";

/** What the developer explicitly declared. Always a preference, never an inference. */
export interface ExplicitPreferences {
  readonly preferredLanguages: readonly string[];
  readonly preferredDifficulty: Difficulty | undefined;
  readonly defaultMode: DeveloperMode;
  readonly workspaceRoot: string | undefined;
}

export interface CreateExplicitPreferencesInput {
  readonly preferredLanguages?: readonly string[];
  readonly preferredDifficulty?: Difficulty;
  readonly defaultMode?: DeveloperMode;
  readonly workspaceRoot?: string;
}

/** The resolved developer context where explicit preferences override inferred signals. */
export interface DeveloperContext {
  readonly preferredLanguages: readonly string[];
  readonly preferredDifficulty: Difficulty | undefined;
  readonly mode: DeveloperMode;
  readonly workspaceRoot: string | undefined;
  readonly languageAffinity: Readonly<Record<string, number>>;
  readonly missionTypeAffinity: Readonly<Record<ChallengeType, number>>;
  readonly interestAffinity: Readonly<Record<string, number>>;
  readonly scopeAffinity: Readonly<Record<string, number>>;
  readonly recentPatterns: readonly string[];
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

export function createExplicitPreferences(
  input: CreateExplicitPreferencesInput,
): DomainResult<ExplicitPreferences> {
  return ok({
    preferredLanguages: dedupe(input.preferredLanguages),
    preferredDifficulty: input.preferredDifficulty,
    defaultMode: input.defaultMode ?? "GUIDED",
    workspaceRoot: input.workspaceRoot,
  });
}

/** Merge explicit preferences and learned signals; explicit values are authoritative. */
export function resolveDeveloperContext(
  explicit: ExplicitPreferences,
  learned: LearnedSignals,
): DeveloperContext {
  return {
    preferredLanguages: explicit.preferredLanguages,
    preferredDifficulty: explicit.preferredDifficulty,
    mode: explicit.defaultMode,
    workspaceRoot: explicit.workspaceRoot,
    languageAffinity: learned.languageAffinity,
    missionTypeAffinity: learned.missionTypeAffinity,
    interestAffinity: learned.interestAffinity,
    scopeAffinity: learned.scopeAffinity,
    recentPatterns: learned.recentPatterns,
  };
}
