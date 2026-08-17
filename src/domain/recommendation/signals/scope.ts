import { result, type SignalInput } from "./shared.js";

export function evaluateScope(input: SignalInput) {
  const affinities = Object.entries(input.developer.scopeAffinity);
  if (affinities.length === 0) {
    return result("scope", 0.5, 0, "no scope affinity data");
  }
  const labels = input.challenge.labels.map((l) => l.toLowerCase());
  let scope = "medium";
  if (labels.includes("good first issue")) {
    scope = "small";
  }
  if (labels.some((l) => /help wanted|hard|difficult/.test(l))) {
    scope = "large";
  }
  const affinity = input.developer.scopeAffinity[scope];
  return affinity !== undefined
    ? result("scope", affinity, 1, "scope " + scope + " affinity " + affinity)
    : result("scope", 0.5, 0.3, "no affinity for scope " + scope);
}
