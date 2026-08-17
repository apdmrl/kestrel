import type { Challenge } from "../../challenge/challenge.js";
import type { EvaluationContext } from "../../challenge/evaluation-context.js";
import type { DeveloperContext } from "../../preferences/preferences.js";
import type { Mood } from "../mood.js";
import type { SignalResult } from "../signal-result.js";

export interface SignalInput {
  readonly challenge: Challenge;
  readonly context: EvaluationContext;
  readonly developer: DeveloperContext;
  readonly mood: Mood;
}

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function result(
  name: string,
  value: number,
  confidence: number,
  reason: string,
): SignalResult {
  return { name, value: clamp01(value), confidence: clamp01(confidence), reason };
}
