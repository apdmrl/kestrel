import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
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

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT"
  );
}

/**
 * Walk every existing path component between root and target with lstat,
 * rejecting any symbolic link or reparse point. Components that do not exist
 * yet are skipped (they are created below and verified afterwards).
 */
async function assertNoSymlinkComponents(root: string, target: string): Promise<void> {
  const relativeTarget = relative(root, target);
  if (relativeTarget === "" || relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
    throw unsafePathError(target);
  }
  const parts = relativeTarget.split(sep).filter((part) => part.length > 0);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    let entry;
    try {
      entry = await lstat(current);
    } catch (error) {
      if (isEnoent(error)) {
        return; // nothing below this component exists yet
      }
      throw error;
    }
    if (entry.isSymbolicLink()) {
      throw unsafePathError(current);
    }
  }
}

export class FilesystemWorkspaceManager implements WorkspaceManager {
  planWorkspace(
    root: string,
    missionId: MissionId,
    repository: RepositoryIdentity,
    issueNumber: number,
  ): WorkspacePlan {
    if (!isAbsolute(root)) {
      throw unsafePathError(root);
    }
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
    if (!isAbsolute(plan.root)) {
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
    if (isWithin(repositoryPath, sidecarPath) || isWithin(sidecarPath, repositoryPath)) {
      throw unsafePathError(sidecarPath);
    }
  }

  async createSidecar(plan: WorkspacePlan): Promise<void> {
    this.assertSafePath(plan);

    const rootReal = await realpath(plan.root).catch(() => undefined);
    if (rootReal !== undefined) {
      await assertNoSymlinkComponents(rootReal, resolve(plan.missionDirectory));
    }

    await mkdir(join(plan.sidecarPath, "handoffs"), { recursive: true });

    // Verify real paths after creation stay within the workspace root.
    const verifiedRoot = await realpath(plan.root);
    const sidecarReal = await realpath(plan.sidecarPath);
    if (!isWithin(verifiedRoot, sidecarReal)) {
      throw unsafePathError(plan.sidecarPath);
    }
    await assertNoSymlinkComponents(verifiedRoot, resolve(plan.sidecarPath));
  }
}
