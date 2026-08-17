import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { createKestrelError } from "../../application/errors/kestrel-error.js";
import type { RepositoryIdentity } from "../../domain/challenge/repository-identity.js";
import type { MissionId } from "../../domain/shared/identifiers.js";
import type { WorkspaceManager, WorkspacePlan } from "../../ports/workspace-manager.js";

function unsafePathError(path: string) {
  return createKestrelError({
    code: "DM_UNSAFE_PATH",
    category: "INVALID_INPUT",
    userMessage: "The computed workspace path is not safe",
    suggestedActions: ["Choose a different workspace root or repository"],
    retryability: "NO_RETRY",
    recoveryStrategy: "USER_ACTION",
    severity: "ERROR",
    debugContext: { path },
  });
}

function slug(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length === 0 ? "x" : cleaned;
}

function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

export class FilesystemWorkspaceManager implements WorkspaceManager {
  planWorkspace(
    root: string,
    missionId: MissionId,
    repository: RepositoryIdentity,
    issueNumber: number,
  ): WorkspacePlan {
    const repoSlug = slug(repository.name);
    const missionDirectory = join(root, slug(missionId) + "-" + repoSlug + "-" + issueNumber);
    return {
      root,
      missionDirectory,
      repositoryPath: join(missionDirectory, "repo"),
      sidecarPath: join(missionDirectory, "kestrel"),
      branchName: "kestrel/" + issueNumber + "-" + repoSlug,
    };
  }

  assertSafePath(plan: WorkspacePlan): void {
    if (!isAbsolute(resolve(plan.root))) {
      throw unsafePathError(plan.root);
    }
    const root = resolve(plan.root);
    const missionDirectory = resolve(plan.missionDirectory);
    const repositoryPath = resolve(plan.repositoryPath);
    const sidecarPath = resolve(plan.sidecarPath);

    for (const path of [missionDirectory, repositoryPath, sidecarPath]) {
      if (!isWithin(root, path)) {
        throw unsafePathError(path);
      }
    }
    if (isWithin(repositoryPath, sidecarPath)) {
      throw unsafePathError(sidecarPath);
    }
  }

  async createSidecar(plan: WorkspacePlan): Promise<void> {
    this.assertSafePath(plan);

    const rootReal = await realpath(plan.root).catch(() => resolve(plan.root));
    const missionReal = await realpath(plan.missionDirectory).catch(() => undefined);
    if (missionReal !== undefined && !isWithin(rootReal, missionReal)) {
      throw unsafePathError(plan.missionDirectory);
    }

    await mkdir(join(plan.sidecarPath, "handoffs"), { recursive: true });
  }
}
