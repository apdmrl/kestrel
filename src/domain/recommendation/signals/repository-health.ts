import { result, type SignalInput } from "./shared.js";

export function evaluateRepositoryHealth(input: SignalInput) {
  const health = input.context.repositoryHealth;
  if (health === undefined) {
    return result("repository-health", 0.5, 0, "no repository health observation");
  }
  return result("repository-health", health, 1, "repository health " + health);
}
