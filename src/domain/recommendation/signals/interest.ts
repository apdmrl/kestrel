import { result, type SignalInput } from "./shared.js";

export function evaluateInterest(input: SignalInput) {
  const affinities = Object.entries(input.developer.interestAffinity);
  if (affinities.length === 0) {
    return result("interest", 0.5, 0, "no interest affinity data");
  }
  const keys = [...input.challenge.labels, ...input.challenge.topics].map((t) => t.toLowerCase());
  let max = 0;
  let matched = false;
  for (const [key, value] of affinities) {
    if (keys.includes(key.toLowerCase())) {
      max = Math.max(max, value);
      matched = true;
    }
  }
  return matched
    ? result("interest", max, 1, "matches known interests")
    : result("interest", 0, 0.5, "no known interest match");
}
