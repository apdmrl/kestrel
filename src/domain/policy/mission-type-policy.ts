import type { ChallengeType } from "../challenge/challenge.js";
import type { EvidenceDecision } from "./evidence-decision.js";

export interface DiscoveryHints {
  readonly labels: readonly string[];
  readonly topics: readonly string[];
}

export interface RankingHints {
  readonly preferredSignals: readonly string[];
}

export interface MissionGuidance {
  readonly steps: readonly string[];
}

export interface AgentBriefPolicy {
  readonly investigationGoals: readonly string[];
  readonly workflow: readonly string[];
  readonly verificationExpectations: readonly string[];
  readonly riskNotes: readonly string[];
}

export interface ReflectionHints {
  readonly prompts: readonly string[];
}

/** The local evidence a policy evaluates before allowing completion. */
export interface EvidenceEvaluationInput {
  readonly commitCount: number;
  readonly filesChanged: readonly string[];
  readonly hasTrackedChanges: boolean;
}

/**
 * Encapsulates all mission-type-specific behavior (Bug Fix, Testing, Documentation)
 * as plain, deterministic TypeScript objects — no plugin registry.
 */
export interface MissionTypePolicy {
  readonly type: ChallengeType;
  readonly version: number;
  readonly discoveryHints: DiscoveryHints;
  readonly rankingHints: RankingHints;
  readonly missionGuidance: MissionGuidance;
  readonly agentBriefPolicy: AgentBriefPolicy;
  readonly reflectionHints: ReflectionHints;
  evaluateEvidence(input: EvidenceEvaluationInput): EvidenceDecision;
}
