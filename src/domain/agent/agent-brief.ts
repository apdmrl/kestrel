import type { DeveloperMode } from "../preferences/preferences.js";
import type { MissionId } from "../shared/identifiers.js";
import type { IsoDateTime } from "../shared/time.js";
import type { RepositoryIdentity } from "../challenge/repository-identity.js";
import type { ChallengeType } from "../challenge/challenge.js";

export interface AgentBrief {
  readonly schemaVersion: 1;
  readonly policyVersion: number;
  readonly generatedAt: IsoDateTime;
  readonly missionId: MissionId;
  readonly mode: DeveloperMode;
  readonly missionType: ChallengeType;
  readonly repository: RepositoryIdentity;
  readonly objective: string;
  readonly challengeTitle: string;
  readonly challengeDescription: string;
  readonly investigationGoals: readonly string[];
  readonly workflow: readonly string[];
  readonly constraints: readonly string[];
  readonly verificationExpectations: readonly string[];
  readonly repositoryInstructions: readonly string[];
  readonly developerHypothesis: string | undefined;
  readonly agentBehavior: readonly string[];
  readonly riskNotes: readonly string[];
}
