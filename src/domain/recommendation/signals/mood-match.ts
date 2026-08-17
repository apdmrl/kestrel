import { result, type SignalInput } from "./shared.js";

export function evaluateMoodMatch(input: SignalInput) {
  const labels = input.challenge.labels.map((l) => l.toLowerCase());
  const hasGoodFirst = labels.includes("good first issue");
  const hasHard = labels.includes("help wanted") || labels.some((l) => /hard|difficult/.test(l));

  switch (input.mood) {
    case "QUICK_WIN":
      return hasGoodFirst
        ? result("mood-match", 1, 1, "has a good-first-issue label")
        : result("mood-match", 0.3, 0.5, "not explicitly a quick win");
    case "DEEP_DEBUGGING":
      return input.challenge.type === "BUG_FIX"
        ? result("mood-match", 1, 1, "is a bug fix")
        : result("mood-match", 0.2, 0.8, "not a bug fix");
    case "LEARN_SOMETHING_NEW":
      return result("mood-match", 0.5, 0.3, "novelty is evaluated separately");
    case "HARD_CHALLENGE":
      return hasHard
        ? result("mood-match", 1, 1, "has a help-wanted or difficult label")
        : result("mood-match", 0.3, 0.5, "not explicitly hard");
    case "SURPRISE_ME":
      return result("mood-match", 0.5, 0.3, "surprise mode is neutral");
  }
}
