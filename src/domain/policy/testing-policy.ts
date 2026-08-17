import type { MissionTypePolicy } from "./mission-type-policy.js";
import type { EvidenceDecision } from "./evidence-decision.js";
import type { EvidenceEvaluationInput } from "./mission-type-policy.js";
import { isTestFile } from "./file-classification.js";

const NO_CHANGES_BLOCK = "no commits or tracked changes since the mission base";

export const testingPolicy: MissionTypePolicy = {
  type: "TESTING",
  version: 1,
  discoveryHints: {
    labels: ["testing", "test", "coverage"],
    topics: ["testing"],
  },
  rankingHints: { preferredSignals: ["issue-quality", "scope"] },
  missionGuidance: {
    steps: [
      "Identify the behavior gap",
      "Define the expected behavior",
      "Add a meaningful test",
      "Avoid implementation-detail testing",
      "Verify test quality",
    ],
  },
  agentBriefPolicy: {
    investigationGoals: ["Identify the untested behavior", "Define the expected behavior"],
    workflow: ["identify", "define", "test", "verify"],
    verificationExpectations: ["A meaningful test for a previously untested behavior"],
    riskNotes: ["Avoid tests that merely mirror implementation details"],
  },
  reflectionHints: { prompts: ["What behavior did the new test lock down?"] },
  evaluateEvidence(input: EvidenceEvaluationInput): EvidenceDecision {
    if (input.commitCount === 0 && !input.hasTrackedChanges) {
      return { accepted: false, blockingReasons: [NO_CHANGES_BLOCK], warnings: [] };
    }
    if (!input.filesChanged.some(isTestFile)) {
      return {
        accepted: false,
        blockingReasons: ["testing missions require a test-file change or explicit test artifact"],
        warnings: [],
      };
    }
    return { accepted: true, blockingReasons: [], warnings: [] };
  },
};
