import { buildAgentBrief } from "../agent/build-agent-brief.js";
import { createJourneyEvent } from "../../domain/journey/journey-event.js";
import type { Mission } from "../../domain/mission/mission.js";
import type { WorkspaceInfo } from "../../domain/mission/mission.js";
import type { PreparationCheckpoint } from "../../domain/mission/preparation-checkpoint.js";
import { PREPARATION_CHECKPOINTS } from "../../domain/mission/preparation-checkpoint.js";
import { policyFor } from "../../domain/policy/policies.js";
import type { MissionId } from "../../domain/shared/identifiers.js";
import type { Clock } from "../../ports/clock.js";
import type { GitClient } from "../../ports/git-client.js";
import type { IdGenerator } from "../../ports/id-generator.js";
import type { JourneyStore } from "../../ports/journey-store.js";
import type { MissionLock } from "../../ports/mission-lock.js";
import type { MissionStore } from "../../ports/mission-store.js";
import type { TransactionJournal } from "../../ports/transaction-journal.js";
import type { WorkspaceManager, WorkspacePlan } from "../../ports/workspace-manager.js";
import { createKestrelError, isKestrelError } from "../errors/kestrel-error.js";
import { commitMissionChange } from "../transactions/commit-mission-change.js";

export interface PrepareMissionDeps {
  readonly lock: MissionLock;
  readonly journal: TransactionJournal;
  readonly missionStore: MissionStore;
  readonly journeyStore: JourneyStore;
  readonly workspaceManager: WorkspaceManager;
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
  readonly gitFactory: (cwd: string) => GitClient;
  readonly signal?: AbortSignal;
}

export interface PrepareMissionInput {
  readonly mission: Mission;
  readonly sidecarPath: string;
  readonly lockPath: string;
  readonly plan: WorkspacePlan;
  readonly upstreamUrl: string;
  readonly expectedStateVersion: number;
}

function interrupted(cause: unknown) {
  return createKestrelError({
    code: "DM_MISSION_PREPARATION_INTERRUPTED",
    category: "RECOVERABLE_STATE",
    userMessage: "Mission preparation was interrupted and can be resumed",
    suggestedActions: ["Resume preparation", "Start over", "Abandon"],
    retryability: "NO_RETRY",
    recoveryStrategy: "RESUME",
    severity: "WARNING",
    cause,
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw interrupted(new Error("aborted"));
  }
}

/** Idempotently prepare a mission, replaying already-recorded checkpoints. */
export async function prepareMission(
  deps: PrepareMissionDeps,
  input: PrepareMissionInput,
): Promise<Mission> {
  const mission = await deps.lock.withMissionLock(
    input.lockPath,
    input.mission.id,
    "prepare",
    async () => {
      let current = input.mission;
      for (const checkpoint of PREPARATION_CHECKPOINTS) {
        throwIfAborted(deps.signal);
        if (current.preparationCheckpoints.some((c) => c.checkpoint === checkpoint)) {
          continue;
        }
        try {
          current = await executeCheckpoint(deps, input, current, checkpoint);
        } catch (error) {
          if (isKestrelError(error)) {
            throw error;
          }
          throw interrupted(error);
        }
      }

      const baseCommit = checkpointData(current, "BASE_RECORDED").baseCommit as string;
      const branch = checkpointData(current, "BRANCH_CREATED").branch as string;
      const completed = current.completePreparation({
        workspace: toWorkspaceInfo(input.plan),
        baseCommit,
        branch,
      });
      if (!completed.ok) {
        throw interrupted(completed.error);
      }

      const transactionId = deps.idGenerator.newTransactionId();
      const event = createJourneyEvent({
        eventId: deps.idGenerator.newEventId(),
        missionId: current.id,
        type: "MissionPreparationCompleted",
        occurredAt: deps.clock.now(),
      });
      if (!event.ok) {
        throw interrupted(event.error);
      }
      await commitMissionChange(
        {
          lock: deps.lock,
          journal: deps.journal,
          missionStore: deps.missionStore,
          journeyStore: deps.journeyStore,
        },
        {
          transactionId,
          missionId: current.id,
          sidecarPath: input.sidecarPath,
          operation: "prepare",
          expectedStateVersion: input.expectedStateVersion,
          targetMission: completed.value,
          event: event.value,
        },
      );
      return completed.value;
    },
  );
  return mission;
}

function checkpointData(
  mission: Mission,
  checkpoint: PreparationCheckpoint,
): Readonly<Record<string, unknown>> {
  return mission.preparationCheckpoints.find((c) => c.checkpoint === checkpoint)?.data ?? {};
}

function toWorkspaceInfo(plan: WorkspacePlan): WorkspaceInfo {
  return {
    root: plan.root,
    missionDirectory: plan.missionDirectory,
    repositoryPath: plan.repositoryPath,
    sidecarPath: plan.sidecarPath,
  };
}

async function executeCheckpoint(
  deps: PrepareMissionDeps,
  input: PrepareMissionInput,
  mission: Mission,
  checkpoint: PreparationCheckpoint,
): Promise<Mission> {
  switch (checkpoint) {
    case "WORKSPACE_CREATED": {
      await deps.workspaceManager.createSidecar(input.plan);
      const result = mission.recordPreparationCheckpoint(checkpoint, {});
      return result.ok ? result.value : mission;
    }
    case "REPOSITORY_CLONED": {
      const git = deps.gitFactory(input.plan.root);
      await git.clone(input.upstreamUrl, input.plan.repositoryPath);
      const result = mission.recordPreparationCheckpoint(checkpoint, {});
      return result.ok ? result.value : mission;
    }
    case "BASE_RECORDED": {
      const git = deps.gitFactory(input.plan.repositoryPath);
      const defaultBranch = await git.getDefaultBranch();
      const baseCommit = await git.getHeadSha();
      const result = mission.recordPreparationCheckpoint(checkpoint, { baseCommit, defaultBranch });
      return result.ok ? result.value : mission;
    }
    case "BRANCH_CREATED": {
      const git = deps.gitFactory(input.plan.repositoryPath);
      await git.createBranch(input.plan.branchName);
      const result = mission.recordPreparationCheckpoint(checkpoint, {
        branch: input.plan.branchName,
      });
      return result.ok ? result.value : mission;
    }
    case "CONTEXT_COLLECTED": {
      const result = mission.recordPreparationCheckpoint(checkpoint, {});
      return result.ok ? result.value : mission;
    }
    case "GUIDANCE_GENERATED": {
      const guidance = policyFor(mission.challengeSnapshot.type).missionGuidance.steps;
      const result = mission.recordPreparationCheckpoint(checkpoint, { guidance });
      return result.ok ? result.value : mission;
    }
    case "BRIEF_GENERATED": {
      const brief = buildAgentBrief(deps.clock, { mission });
      const result = mission.recordPreparationCheckpoint(checkpoint, { brief });
      return result.ok ? result.value : mission;
    }
  }
}

export function restartConfirmationToken(missionId: MissionId, sidecarPath: string): string {
  return missionId + "::" + sidecarPath;
}

/** Verify that a "start over" confirmation token matches the mission and safe path. */
export function confirmRestart(missionId: MissionId, sidecarPath: string, token: string): boolean {
  return token === restartConfirmationToken(missionId, sidecarPath);
}
