import { createKestrelError } from "../errors/kestrel-error.js";
import type { RepositoryIdentity } from "../../domain/challenge/repository-identity.js";
import type { GitClient, LocalChanges } from "../../ports/git-client.js";

export interface CollectLocalEvidenceDeps {
  readonly git: GitClient;
}

export interface CollectLocalEvidenceInput {
  readonly repository: RepositoryIdentity;
  readonly baseSha: string;
}

export interface LocalEvidence {
  readonly commits: readonly string[];
  readonly headSha: string;
  readonly filesChanged: readonly string[];
  readonly insertions: number;
  readonly deletions: number;
  readonly workingTreeState: "CLEAN" | "DIRTY";
}

function repositoryMismatchError() {
  return createKestrelError({
    code: "DM_REPOSITORY_MISMATCH",
    category: "EXTERNAL_STATE_CHANGED",
    userMessage: "The repository identity no longer matches the mission",
    suggestedActions: ["Verify the repository before continuing"],
    retryability: "NO_RETRY",
    recoveryStrategy: "MANUAL_INTERVENTION",
    severity: "ERROR",
  });
}

function baseShaMissingError() {
  return createKestrelError({
    code: "DM_BASE_SHA_MISSING",
    category: "EXTERNAL_STATE_CHANGED",
    userMessage: "The mission base commit is no longer present",
    suggestedActions: ["Restore the base commit, or restart the mission"],
    retryability: "NO_RETRY",
    recoveryStrategy: "MANUAL_INTERVENTION",
    severity: "ERROR",
  });
}

/** Collect local engineering evidence against the immutable mission base SHA. */
export async function collectLocalEvidence(
  deps: CollectLocalEvidenceDeps,
  input: CollectLocalEvidenceInput,
): Promise<LocalEvidence> {
  const identity = await deps.git.getRepositoryIdentity();
  if (identity.owner !== input.repository.owner || identity.name !== input.repository.name) {
    throw repositoryMismatchError();
  }

  if (!(await deps.git.commitExists(input.baseSha))) {
    throw baseShaMissingError();
  }

  const changes: LocalChanges = await deps.git.collectChangesSince(input.baseSha);
  return {
    commits: changes.commits,
    headSha: changes.headSha,
    filesChanged: changes.filesChanged,
    insertions: changes.insertions,
    deletions: changes.deletions,
    workingTreeState: changes.workingTreeState,
  };
}
