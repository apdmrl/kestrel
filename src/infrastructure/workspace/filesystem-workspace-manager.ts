import { lstat, mkdir, realpath, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

export interface FilesystemWorkspaceManagerHooks {
  /** Test seam: invoked just before creating a missing directory component. */
  readonly beforeCreateDirectory?: (path: string) => Promise<void> | void;
}

export class FilesystemWorkspaceManager implements WorkspaceManager {
  constructor(private readonly hooks: FilesystemWorkspaceManagerHooks = {}) {}

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

    const root = resolve(plan.root);
    await mkdir(root, { recursive: true });
    const rootReal = await realpath(root);

    const missionDirectory = this.canonicalTarget(root, rootReal, plan.missionDirectory);
    const sidecarPath = this.canonicalTarget(root, rootReal, plan.sidecarPath);
    const handoffsPath = this.canonicalTarget(root, rootReal, join(plan.sidecarPath, "handoffs"));

    await this.createDirectoryWithinRoot(rootReal, missionDirectory);
    await this.createDirectoryWithinRoot(rootReal, sidecarPath);
    await this.createDirectoryWithinRoot(rootReal, handoffsPath);
  }

  /** Map a plan path (resolved against the configured root) onto the canonical root. */
  private canonicalTarget(root: string, rootReal: string, target: string): string {
    const rel = relative(root, resolve(target));
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw unsafePathError(target);
    }
    return join(rootReal, rel);
  }

  private async createDirectoryWithinRoot(rootReal: string, target: string): Promise<void> {
    const rel = relative(rootReal, target);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw unsafePathError(target);
    }
    const parts = rel.split(sep).filter((part) => part.length > 0);
    let current = rootReal;
    for (const part of parts) {
      current = join(current, part);
      await this.ensureDirectoryComponent(rootReal, current);
    }
  }

  private async ensureDirectoryComponent(rootReal: string, path: string): Promise<void> {
    let existing;
    try {
      existing = await lstat(path);
    } catch (error) {
      if (!isEnoent(error)) {
        throw error;
      }
    }
    if (existing !== undefined) {
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        throw unsafePathError(path);
      }
      return;
    }
    // Test seam between the no-follow check and the directory creation.
    if (this.hooks.beforeCreateDirectory !== undefined) {
      await this.hooks.beforeCreateDirectory(path);
    }
    // Re-verify the parent chain has no symlink before creating the component.
    const parent = dirname(path);
    if (parent !== rootReal) {
      await assertNoSymlinkComponents(rootReal, parent);
    }
    await mkdir(path, { recursive: false });
    const createdReal = await realpath(path);
    if (!isWithin(rootReal, createdReal)) {
      await rmdir(path).catch(() => undefined);
      throw unsafePathError(path);
    }
  }
}
