import type { MissionTypePolicy } from "./mission-type-policy.js";
import type { EvidenceDecision } from "./evidence-decision.js";
import type { EvidenceEvaluationInput } from "./mission-type-policy.js";
import { isTestFile } from "./file-classification.js";

const NO_CHANGES_BLOCK = "no commits or tracked changes since the mission base";

export const bugFixPolicy: MissionTypePolicy = {
  type: "BUG_FIX",
  version: 1,
  discoveryHints: {
    labels: ["bug", "bug-fix", "good first issue"],
    topics: ["bug"],
  },
  rankingHints: { preferredSignals: ["scope", "issue-quality"] },
  missionGuidance: {
    steps: [
      "Understand the reported behavior",
      "Reproduce the failure",
      "Form a hypothesis",
      "Find the root cause",
      "Add regression coverage where practical",
      "Make a minimal justified fix",
      "Verify the fix",
    ],
  },
  agentBriefPolicy: {
    investigationGoals: ["Reproduce the failure", "Locate the root cause"],
    workflow: ["reproduce", "hypothesize", "fix", "verify"],
    verificationExpectations: ["A regression test or reproduction note where practical"],
    riskNotes: ["Avoid unrelated refactors"],
  },
  reflectionHints: { prompts: ["What was the root cause?"] },
  evaluateEvidence(input: EvidenceEvaluationInput): EvidenceDecision {
    if (input.commitCount === 0 && !input.hasTrackedChanges) {
      return { accepted: false, blockingReasons: [NO_CHANGES_BLOCK], warnings: [] };
    }
    const hasRegressionTest = input.filesChanged.some(isTestFile);
    return {
      accepted: true,
      blockingReasons: [],
      warnings: hasRegressionTest
        ? []
        : [
            "No regression-test change detected. This does not block completion, but adding regression coverage may be worth considering.",
          ],
    };
  },
};
