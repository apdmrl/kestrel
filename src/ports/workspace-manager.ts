import type { RepositoryIdentity } from "../domain/challenge/repository-identity.js";
import type { MissionId } from "../domain/shared/identifiers.js";

export interface WorkspacePlan {
  readonly root: string;
  readonly missionDirectory: string;
  readonly repositoryPath: string;
  readonly sidecarPath: string;
  readonly branchName: string;
}

/** Computes and validates safe mission workspace paths (sibling repo/ and kestrel/). */
export interface WorkspaceManager {
  planWorkspace(
    root: string,
    missionId: MissionId,
    repository: RepositoryIdentity,
    issueNumber: number,
  ): WorkspacePlan;
  assertSafePath(plan: WorkspacePlan): void;
  createSidecar(plan: WorkspacePlan): Promise<void>;
}
