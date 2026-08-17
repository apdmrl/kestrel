import { result, type SignalInput } from "./shared.js";

export function evaluateNovelty(input: SignalInput) {
  const recent = input.developer.recentPatterns.map((p) => p.toLowerCase());
  if (recent.length === 0) {
    return result("novelty", 0.5, 0, "no recent-pattern data");
  }
  const keys = [input.challenge.language, ...input.challenge.labels, ...input.challenge.topics]
    .filter((k): k is string => k !== undefined)
    .map((k) => k.toLowerCase());
  const seen = keys.some((k) => recent.includes(k));
  return seen
    ? result("novelty", 0, 1, "similar to recent work")
    : result("novelty", 1, 1, "different from recent work");
}
