import { lstat, mkdir, realpath } from "node:fs/promises";
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
  /**
   * Test seam: invoked after the parent chain has been validated but
   * immediately before the component is created. This is exactly the final
   * check-to-create window that no portable Node API can close atomically.
   */
  readonly beforeDirectoryCreation?: (path: string) => Promise<void> | void;
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

  /**
   * Create one directory component, or verify an existing one, staying inside
   * the canonical root.
   *
   * Node.js on all supported platforms exposes no directory-handle-relative,
   * no-follow creation primitive (no mkdirat/openat) that could make the final
   * check-to-create step atomic, so containment cannot be guaranteed against a
   * concurrent local attacker racing that window. The threat model is therefore
   * constrained and enforced as follows:
   *
   * - every pre-existing symbolic link / reparse point in the path is rejected
   *   (lstat walk plus a final parent re-check);
   * - every component's canonical path is verified after each operation
   *   (realpath), including components that already existed;
   * - a raced mkdir (EEXIST) is re-verified canonically and classified;
   * - cleanup NEVER follows a replaced parent: an escaped artifact is left for
   *   the operator rather than deleted through a symlink.
   *
   * The residual limitation — a concurrent local attacker who replaces a parent
   * in the final window can redirect creation — is documented in
   * docs/security.md and is inherent to the runtime.
   */
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
      // Canonically verify an existing component never resolves outside the
      // root through a parent that was replaced since the walk.
      const existingReal = await realpath(path);
      if (!isWithin(rootReal, existingReal)) {
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
    // Test seam AFTER the final parent validation, immediately before creation:
    // the exact window no portable Node API can make atomic.
    if (this.hooks.beforeDirectoryCreation !== undefined) {
      await this.hooks.beforeDirectoryCreation(path);
    }
    try {
      await mkdir(path, { recursive: false });
    } catch (error) {
      if ((error as { code?: string }).code === "EEXIST") {
        // A concurrent actor created the component between our lstat and mkdir.
        // Verify it canonically; never treat a path that resolves outside the
        // root as acceptable.
        const raced = await realpath(path).catch(() => undefined);
        if (raced === undefined || !isWithin(rootReal, raced)) {
          throw unsafePathError(path);
        }
        return;
      }
      throw error;
    }
    const createdReal = await realpath(path);
    if (!isWithin(rootReal, createdReal)) {
      // The parent was replaced during creation. Never run cleanup through the
      // replaced parent: the escaped empty artifact is left for the operator.
      throw unsafePathError(path);
    }
  }
}
