import type { Challenge } from "../challenge/challenge.js";
import { snapshotChallenge } from "../challenge/challenge.js";
import { createEvidenceCollection } from "../evidence/evidence-collection.js";
import type { EvidenceCollection } from "../evidence/evidence-collection.js";
import type { EvidenceDecision } from "../policy/evidence-decision.js";
import type { DeveloperMode } from "../preferences/preferences.js";
import type { RecommendationSnapshot } from "../recommendation/recommendation.js";
import { snapshotRecommendation } from "../recommendation/recommendation.js";
import type { MissionId } from "../shared/identifiers.js";
import type { DomainResult } from "../shared/result.js";
import { err, ok } from "../shared/result.js";
import type { IsoDateTime } from "../shared/time.js";
import type { MissionStatus } from "./mission-status.js";

export interface AcceptanceContext {
  readonly mode: DeveloperMode;
  readonly workspaceRoot: string | undefined;
  readonly acceptedAt: IsoDateTime;
}

export interface WorkspaceInfo {
  readonly root: string;
  readonly missionDirectory: string;
  readonly repositoryPath: string;
  readonly sidecarPath: string;
}

interface MissionState {
  readonly id: MissionId;
  readonly challengeSnapshot: Challenge;
  readonly recommendationSnapshot: RecommendationSnapshot;
  readonly acceptanceContext: AcceptanceContext;
  readonly status: MissionStatus;
  readonly workspace: WorkspaceInfo | undefined;
  readonly immutableBaseCommit: string | undefined;
  readonly branch: string | undefined;
  readonly evidence: EvidenceCollection;
}

export interface AcceptMissionInput {
  readonly id: MissionId;
  readonly challengeSnapshot: Challenge;
  readonly recommendationSnapshot: RecommendationSnapshot;
  readonly mode: DeveloperMode;
  readonly workspaceRoot?: string;
  readonly acceptedAt: IsoDateTime;
}

export interface CompletePreparationInput {
  readonly workspace: WorkspaceInfo;
  readonly baseCommit: string;
  readonly branch: string;
}

/**
 * The Mission aggregate root. Lifecycle state changes only through these methods;
 * there is no public constructor and no mutable status setter.
 */
export class Mission {
  private constructor(private readonly state: MissionState) {}

  static accept(input: AcceptMissionInput): DomainResult<Mission> {
    if (input.id.trim().length === 0) {
      return err("DM_INVALID_MISSION", "mission id must not be empty");
    }
    if (input.acceptedAt.trim().length === 0) {
      return err("DM_INVALID_MISSION", "acceptedAt must not be empty");
    }
    return ok(
      new Mission({
        id: input.id,
        challengeSnapshot: snapshotChallenge(input.challengeSnapshot),
        recommendationSnapshot: snapshotRecommendation(input.recommendationSnapshot),
        acceptanceContext: {
          mode: input.mode,
          workspaceRoot: input.workspaceRoot,
          acceptedAt: input.acceptedAt,
        },
        status: "ACCEPTED",
        workspace: undefined,
        immutableBaseCommit: undefined,
        branch: undefined,
        evidence: createEvidenceCollection(),
      }),
    );
  }

  startPreparation(): DomainResult<Mission> {
    if (this.state.status !== "ACCEPTED") {
      return err("DM_ILLEGAL_TRANSITION", `cannot start preparation from ${this.state.status}`);
    }
    return ok(new Mission({ ...this.state, status: "PREPARING" }));
  }

  completePreparation(input: CompletePreparationInput): DomainResult<Mission> {
    if (this.state.status !== "PREPARING") {
      return err("DM_ILLEGAL_TRANSITION", `cannot complete preparation from ${this.state.status}`);
    }
    if (input.baseCommit.trim().length === 0) {
      return err("DM_INVALID_MISSION", "baseCommit must not be empty");
    }
    if (input.branch.trim().length === 0) {
      return err("DM_INVALID_MISSION", "branch must not be empty");
    }
    return ok(
      new Mission({
        ...this.state,
        status: "IN_PROGRESS",
        workspace: { ...input.workspace },
        immutableBaseCommit: input.baseCommit,
        branch: input.branch,
      }),
    );
  }

  complete(evidenceDecision: EvidenceDecision): DomainResult<Mission> {
    if (this.state.status !== "IN_PROGRESS") {
      return err("DM_ILLEGAL_TRANSITION", `cannot complete from ${this.state.status}`);
    }
    if (!evidenceDecision.accepted) {
      const reasons =
        evidenceDecision.blockingReasons.length > 0
          ? evidenceDecision.blockingReasons.join("; ")
          : "completion blocked by the active policy";
      return err("DM_EVIDENCE_BLOCKED", reasons);
    }
    return ok(new Mission({ ...this.state, status: "COMPLETED" }));
  }

  abandon(reason: string): DomainResult<Mission> {
    if (this.state.status === "COMPLETED" || this.state.status === "ABANDONED") {
      return err("DM_ILLEGAL_TRANSITION", `cannot abandon from ${this.state.status}`);
    }
    if (reason.trim().length === 0) {
      return err("DM_INVALID_MISSION", "abandon reason must not be empty");
    }
    return ok(new Mission({ ...this.state, status: "ABANDONED" }));
  }

  get id(): MissionId {
    return this.state.id;
  }

  get status(): MissionStatus {
    return this.state.status;
  }

  get challengeSnapshot(): Challenge {
    return this.state.challengeSnapshot;
  }

  get recommendationSnapshot(): RecommendationSnapshot {
    return this.state.recommendationSnapshot;
  }

  get acceptanceContext(): AcceptanceContext {
    return this.state.acceptanceContext;
  }

  get workspace(): WorkspaceInfo | undefined {
    return this.state.workspace;
  }

  get immutableBaseCommit(): string | undefined {
    return this.state.immutableBaseCommit;
  }

  get branch(): string | undefined {
    return this.state.branch;
  }

  get evidence(): EvidenceCollection {
    return this.state.evidence;
  }
}
