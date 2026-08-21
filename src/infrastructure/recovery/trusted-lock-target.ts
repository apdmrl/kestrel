import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createKestrelError } from "../../application/errors/kestrel-error.js";
import type { MissionId } from "../../domain/shared/identifiers.js";

export function unsafeRecoveryPathError(path: string, detail: string) {
  return createKestrelError({
    code: "DM_UNSAFE_PATH",
    category: "INVALID_INPUT",
    userMessage: "The mission recovery target is not a safe, managed location",
    suggestedActions: ["Inspect the mission index and pending transactions"],
    retryability: "NO_RETRY",
    recoveryStrategy: "MANUAL_INTERVENTION",
    severity: "ERROR",
    debugContext: { path, detail },
  });
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT"
  );
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function realpathOrResolve(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isEnoent(error)) {
      return resolve(path);
    }
    throw error;
  }
}

/**
 * Reject every symbolic link / reparse component on the existing portion of the
 * path between `root` and `target`. Components that do not exist are skipped.
 */
async function assertNoSymlinkComponents(root: string, target: string): Promise<void> {
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw unsafeRecoveryPathError(target, "target is not within the managed root");
  }
  const parts = rel.split(sep).filter((part) => part.length > 0);
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
      throw unsafeRecoveryPathError(current, "symlink component in the recovery target");
    }
  }
}

export interface TrustedLockTarget {
  readonly sidecarPath: string;
  readonly lockPath: string;
}

/**
 * Derive and verify a trusted mission lock target for destructive stale-lock
 * recovery. A raw `sidecarPath` from index/journal JSON is never trusted:
 *
 * - the resolved sidecar must be lexically contained in the managed workspace
 *   root (using `resolve`/`relative`, never a raw `startsWith`);
 * - every existing component on the path is walked with `lstat` and any
 *   symlink / reparse component is rejected, so a link is never followed to
 *   delete a target elsewhere;
 * - canonical containment is re-checked with `realpath` so a path that is
 *   lexically inside but canonically outside (via a symlink) is rejected.
 *
 * The returned lock path is always `<sidecar>/.lock` beneath the trusted sidecar.
 * This fails closed: any uncertainty resolves to DM_UNSAFE_PATH and the lock is
 * never touched.
 */
export async function verifyTrustedLockTarget(opts: {
  workspaceRoot: string;
  missionId: MissionId;
  sidecarPath: string;
}): Promise<TrustedLockTarget> {
  const root = resolve(opts.workspaceRoot);
  const target = resolve(opts.sidecarPath);
  if (!isWithin(root, target)) {
    throw unsafeRecoveryPathError(target, "sidecar escapes the managed workspace root");
  }

  await assertNoSymlinkComponents(root, target);

  const rootReal = await realpathOrResolve(root);
  const targetReal = await realpathOrResolve(target);
  if (!isWithin(rootReal, targetReal)) {
    throw unsafeRecoveryPathError(target, "sidecar resolves outside the managed workspace root");
  }

  const lockPath = join(target, ".lock");
  if (!isWithin(target, lockPath)) {
    throw unsafeRecoveryPathError(lockPath, "lock path is not beneath the trusted sidecar");
  }

  return { sidecarPath: target, lockPath };
}
