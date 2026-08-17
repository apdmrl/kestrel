import type { MissionTypePolicy } from "./mission-type-policy.js";
import type { EvidenceDecision } from "./evidence-decision.js";
import type { EvidenceEvaluationInput } from "./mission-type-policy.js";
import { isDocumentationFile } from "./file-classification.js";

const NO_CHANGES_BLOCK = "no commits or tracked changes since the mission base";

export const documentationPolicy: MissionTypePolicy = {
  type: "DOCUMENTATION",
  version: 1,
  discoveryHints: {
    labels: ["documentation", "docs"],
    topics: ["documentation"],
  },
  rankingHints: { preferredSignals: ["issue-quality", "novelty"] },
  missionGuidance: {
    steps: [
      "Identify the ambiguity or missing information",
      "Verify actual project behavior",
      "Improve the explanation or example",
      "Avoid unsupported claims",
    ],
  },
  agentBriefPolicy: {
    investigationGoals: ["Locate the ambiguous or missing documentation"],
    workflow: ["identify", "verify", "improve", "review"],
    verificationExpectations: ["Documentation changes that clarify or correct behavior"],
    riskNotes: ["Verify behavior against the code before documenting"],
  },
  reflectionHints: { prompts: ["What was unclear before?"] },
  evaluateEvidence(input: EvidenceEvaluationInput): EvidenceDecision {
    if (input.commitCount === 0 && !input.hasTrackedChanges) {
      return { accepted: false, blockingReasons: [NO_CHANGES_BLOCK], warnings: [] };
    }
    if (!input.filesChanged.some(isDocumentationFile)) {
      return {
        accepted: false,
        blockingReasons: ["documentation missions require documentation-file changes"],
        warnings: [],
      };
    }
    return { accepted: true, blockingReasons: [], warnings: [] };
  },
};
