import { join } from "node:path";
import { buildAgentBrief } from "../agent/build-agent-brief.js";
import { createJourneyEvent } from "../../domain/journey/journey-event.js";
import type { Mission } from "../../domain/mission/mission.js";
import type { WorkspaceInfo } from "../../domain/mission/mission.js";
import type { PreparationCheckpoint } from "../../domain/mission/preparation-checkpoint.js";
import { PREPARATION_CHECKPOINTS } from "../../domain/mission/preparation-checkpoint.js";
import { policyFor } from "../../domain/policy/policies.js";
import type { RepositoryIdentity } from "../../domain/challenge/repository-identity.js";
import type { MissionId } from "../../domain/shared/identifiers.js";
import type { Clock } from "../../ports/clock.js";
import type { GitClient } from "../../ports/git-client.js";
import type { IdGenerator } from "../../ports/id-generator.js";
import type { JourneyStore } from "../../ports/journey-store.js";
import type { MissionIndexStore } from "../../ports/mission-index-store.js";
import type { MissionLock } from "../../ports/mission-lock.js";
import type { MissionStore } from "../../ports/mission-store.js";
import type { TransactionJournal } from "../../ports/transaction-journal.js";
import type { WorkspaceManager, WorkspacePlan } from "../../ports/workspace-manager.js";
import { createKestrelError, isKestrelError } from "../errors/kestrel-error.js";
import { commitMissionChangeUnderLock } from "../transactions/commit-mission-change.js";

export interface PrepareMissionDeps {
  readonly lock: MissionLock;
  readonly journal: TransactionJournal;
  readonly missionStore: MissionStore;
  readonly journeyStore: JourneyStore;
  readonly indexStore: MissionIndexStore;
  readonly workspaceManager: WorkspaceManager;
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
  readonly gitFactory: (cwd: string) => GitClient;
  readonly signal?: AbortSignal;
}

export interface PrepareMissionInput {
  readonly missionId: MissionId;
  readonly sidecarPath: string;
}

export interface RestartMissionInput extends PrepareMissionInput {
  readonly confirmation: string;
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

function missionNotFound(): ReturnType<typeof createKestrelError> {
  return createKestrelError({
    code: "DM_MISSION_NOT_FOUND",
    category: "USER_ACTION_REQUIRED",
    userMessage: "No persisted mission was found to prepare",
    suggestedActions: ["Accept a mission first"],
    retryability: "NO_RETRY",
    recoveryStrategy: "USER_ACTION",
    severity: "ERROR",
  });
}

function illegalTransition(message: string): ReturnType<typeof createKestrelError> {
  return createKestrelError({
    code: "DM_ILLEGAL_TRANSITION",
    category: "INVALID_INPUT",
    userMessage: message,
    suggestedActions: ["Check the current mission state"],
    retryability: "NO_RETRY",
    recoveryStrategy: "USER_ACTION",
    severity: "ERROR",
  });
}

function externalStateChanged(message: string): ReturnType<typeof createKestrelError> {
  return createKestrelError({
    code: "DM_REPOSITORY_MISMATCH",
    category: "EXTERNAL_STATE_CHANGED",
    userMessage: message,
    suggestedActions: ["Start over with a confirmed restart, or inspect the workspace"],
    retryability: "NO_RETRY",
    recoveryStrategy: "USER_ACTION",
    severity: "ERROR",
  });
}

function checkpointFailure(
  checkpoint: PreparationCheckpoint,
  violation: { readonly code: string; readonly message: string },
): ReturnType<typeof createKestrelError> {
  const conflict = violation.code === "DM_CHECKPOINT_CONFLICT";
  return createKestrelError({
    code: conflict ? "DM_STORE_CONFLICT" : "DM_ILLEGAL_TRANSITION",
    category: conflict ? "CONFLICT" : "INVALID_INPUT",
    userMessage: violation.message,
    suggestedActions: conflict
      ? ["Resume preparation to reconcile the checkpoint"]
      : ["Check the current mission state"],
    retryability: "NO_RETRY",
    recoveryStrategy: "USER_ACTION",
    severity: "ERROR",
    debugContext: { checkpoint },
  });
}

function sameRepository(a: RepositoryIdentity, b: RepositoryIdentity): boolean {
  return a.provider === b.provider && a.owner === b.owner && a.name === b.name;
}

function planFor(deps: PrepareMissionDeps, mission: Mission): WorkspacePlan {
  const root = mission.acceptanceContext.workspaceRoot;
  if (root === undefined || root.trim().length === 0) {
    throw illegalTransition("the mission has no configured workspace root");
  }
  return deps.workspaceManager.planWorkspace(
    root,
    mission.id,
    mission.challengeSnapshot.repository,
    mission.challengeSnapshot.source.issueNumber,
  );
}

function upstreamUrlFor(mission: Mission): string {
  const repository = mission.challengeSnapshot.repository;
  return "https://github.com/" + repository.owner + "/" + repository.name + ".git";
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

async function tryGetRepositoryIdentity(
  deps: PrepareMissionDeps,
  plan: WorkspacePlan,
): Promise<RepositoryIdentity | undefined> {
  try {
    return await deps.gitFactory(plan.repositoryPath).getRepositoryIdentity();
  } catch (error) {
    if (
      isKestrelError(error) &&
      (error.code === "DM_GIT_FATAL" || error.code === "DM_GIT_NOT_FOUND")
    ) {
      return undefined;
    }
    throw error;
  }
}

async function verifyCheckpoint(
  deps: PrepareMissionDeps,
  mission: Mission,
  checkpoint: PreparationCheckpoint,
  plan: WorkspacePlan,
): Promise<void> {
  switch (checkpoint) {
    case "WORKSPACE_CREATED":
      // The sidecar was read from disk at the start of the lock, so its
      // existence is already verified; re-assert the safe path bounds.
      deps.workspaceManager.assertSafePath(plan);
      return;
    case "REPOSITORY_CLONED": {
      const identity = await tryGetRepositoryIdentity(deps, plan);
      if (
        identity === undefined ||
        !sameRepository(identity, mission.challengeSnapshot.repository)
      ) {
        throw externalStateChanged(
          "the cloned repository no longer matches the mission repository",
        );
      }
      return;
    }
    case "BASE_RECORDED": {
      const baseCommit = checkpointData(mission, "BASE_RECORDED").baseCommit as string;
      const git = deps.gitFactory(plan.repositoryPath);
      if (!(await git.commitExists(baseCommit))) {
        throw externalStateChanged("the recorded base commit is no longer present");
      }
      return;
    }
    case "BRANCH_CREATED": {
      const git = deps.gitFactory(plan.repositoryPath);
      const branch = await git.getCurrentBranch();
      if (branch.trim().length === 0) {
        throw externalStateChanged("the repository is not on a branch");
      }
      return;
    }
    default:
      // Context, guidance, and brief checkpoints are derived deterministically
      // and have no external side effect to verify.
      return;
  }
}

async function executeCheckpoint(
  deps: PrepareMissionDeps,
  mission: Mission,
  checkpoint: PreparationCheckpoint,
  plan: WorkspacePlan,
  upstreamUrl: string,
): Promise<Mission> {
  let result;
  switch (checkpoint) {
    case "WORKSPACE_CREATED":
      await deps.workspaceManager.createSidecar(plan);
      result = mission.recordPreparationCheckpoint(checkpoint, {});
      break;
    case "REPOSITORY_CLONED": {
      const existing = await tryGetRepositoryIdentity(deps, plan);
      if (existing === undefined) {
        await deps.gitFactory(plan.root).clone(upstreamUrl, plan.repositoryPath);
      } else if (!sameRepository(existing, mission.challengeSnapshot.repository)) {
        throw externalStateChanged("the clone target contains a different repository");
      }
      result = mission.recordPreparationCheckpoint(checkpoint, {});
      break;
    }
    case "BASE_RECORDED": {
      const git = deps.gitFactory(plan.repositoryPath);
      const defaultBranch = await git.getDefaultBranch();
      const baseCommit = await git.getHeadSha();
      result = mission.recordPreparationCheckpoint(checkpoint, { baseCommit, defaultBranch });
      break;
    }
    case "BRANCH_CREATED":
      await deps.gitFactory(plan.repositoryPath).createBranch(plan.branchName);
      result = mission.recordPreparationCheckpoint(checkpoint, { branch: plan.branchName });
      break;
    case "CONTEXT_COLLECTED":
      result = mission.recordPreparationCheckpoint(checkpoint, {});
      break;
    case "GUIDANCE_GENERATED": {
      const guidance = policyFor(mission.challengeSnapshot.type).missionGuidance.steps;
      result = mission.recordPreparationCheckpoint(checkpoint, { guidance });
      break;
    }
    case "BRIEF_GENERATED": {
      const brief = buildAgentBrief(deps.clock, { mission });
      result = mission.recordPreparationCheckpoint(checkpoint, { brief });
      break;
    }
  }
  if (!result.ok) {
    throw checkpointFailure(checkpoint, result.error);
  }
  return result.value;
}

/**
 * Idempotently prepare a mission, reloading its persisted state and replaying
 * already-recorded checkpoints. The mission lock is acquired exactly once.
 */
export async function prepareMission(
  deps: PrepareMissionDeps,
  input: PrepareMissionInput,
): Promise<Mission> {
  const lockPath = join(input.sidecarPath, ".lock");
  return deps.lock.withMissionLock(lockPath, input.missionId, "prepare", async () => {
    const stored = await deps.missionStore.get(input.sidecarPath);
    if (stored === undefined) {
      throw missionNotFound();
    }
    let current = stored.mission;
    let version = stored.version;

    if (current.status === "ACCEPTED") {
      const preparing = current.startPreparation();
      if (!preparing.ok) {
        throw illegalTransition(preparing.error.message);
      }
      const event = createJourneyEvent({
        eventId: deps.idGenerator.newEventId(),
        missionId: input.missionId,
        type: "MissionPreparationStarted",
        occurredAt: deps.clock.now(),
      });
      if (!event.ok) {
        throw interrupted(event.error);
      }
      await commitMissionChangeUnderLock(deps, {
        transactionId: deps.idGenerator.newTransactionId(),
        missionId: input.missionId,
        sidecarPath: input.sidecarPath,
        operation: "prepare-start",
        expectedStateVersion: version,
        targetMission: preparing.value,
        event: event.value,
      });
      current = preparing.value;
      version += 1;
    } else if (current.status !== "PREPARING") {
      throw illegalTransition("cannot prepare from " + current.status);
    }

    const plan = planFor(deps, current);
    const upstreamUrl = upstreamUrlFor(current);

    for (const checkpoint of PREPARATION_CHECKPOINTS) {
      throwIfAborted(deps.signal);
      const already = current.preparationCheckpoints.find((c) => c.checkpoint === checkpoint);
      if (already !== undefined) {
        await verifyCheckpoint(deps, current, checkpoint, plan);
        continue;
      }
      let next;
      try {
        next = await executeCheckpoint(deps, current, checkpoint, plan, upstreamUrl);
        await deps.missionStore.save(input.sidecarPath, next, version);
      } catch (error) {
        if (isKestrelError(error)) {
          throw error;
        }
        throw interrupted(error);
      }
      current = next;
      version += 1;
    }

    const baseCommit = checkpointData(current, "BASE_RECORDED").baseCommit as string;
    const branch = checkpointData(current, "BRANCH_CREATED").branch as string;
    const completed = current.completePreparation({
      workspace: toWorkspaceInfo(plan),
      baseCommit,
      branch,
    });
    if (!completed.ok) {
      throw interrupted(completed.error);
    }
    const event = createJourneyEvent({
      eventId: deps.idGenerator.newEventId(),
      missionId: input.missionId,
      type: "MissionPreparationCompleted",
      occurredAt: deps.clock.now(),
    });
    if (!event.ok) {
      throw interrupted(event.error);
    }
    await commitMissionChangeUnderLock(deps, {
      transactionId: deps.idGenerator.newTransactionId(),
      missionId: input.missionId,
      sidecarPath: input.sidecarPath,
      operation: "prepare-complete",
      expectedStateVersion: version,
      targetMission: completed.value,
      event: event.value,
    });
    return completed.value;
  });
}

/** Explicitly resume an interrupted preparation by reloading stored state. */
export async function resumeMissionPreparation(
  deps: PrepareMissionDeps,
  input: PrepareMissionInput,
): Promise<Mission> {
  return prepareMission(deps, input);
}

/** Restart preparation: reset checkpoints without touching the clone. */
export async function restartMissionPreparation(
  deps: PrepareMissionDeps,
  input: RestartMissionInput,
): Promise<Mission> {
  if (!confirmRestart(input.missionId, input.sidecarPath, input.confirmation)) {
    throw illegalTransition("restart confirmation does not match the mission");
  }
  const lockPath = join(input.sidecarPath, ".lock");
  return deps.lock.withMissionLock(lockPath, input.missionId, "restart", async () => {
    const stored = await deps.missionStore.get(input.sidecarPath);
    if (stored === undefined) {
      throw missionNotFound();
    }
    const reset = stored.mission.resetPreparation();
    if (!reset.ok) {
      throw illegalTransition(reset.error.message);
    }
    await deps.missionStore.save(input.sidecarPath, reset.value, stored.version);
    return reset.value;
  });
}

export function restartConfirmationToken(missionId: MissionId, sidecarPath: string): string {
  return missionId + "::" + sidecarPath;
}

/** Verify that a "start over" confirmation token matches the mission and safe path. */
export function confirmRestart(missionId: MissionId, sidecarPath: string, token: string): boolean {
  return token === restartConfirmationToken(missionId, sidecarPath);
}
