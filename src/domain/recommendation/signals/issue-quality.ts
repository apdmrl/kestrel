import { result, type SignalInput } from "./shared.js";

export function evaluateIssueQuality(input: SignalInput) {
  const quality = input.context.issueQuality;
  if (quality === undefined) {
    return result("issue-quality", 0.5, 0, "no issue quality observation");
  }
  return result("issue-quality", quality, 1, "issue quality " + quality);
}
