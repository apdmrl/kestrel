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

/** Path canonicalizer injected by tests; production uses the real `realpath`. */
export type PathCanonicalizer = (path: string) => Promise<string>;

export interface VerifyTrustedLockTargetOptions {
  readonly canonicalize?: PathCanonicalizer;
}

/**
 * Derive and verify a trusted mission lock target for destructive stale-lock
 * recovery. A raw `sidecarPath` from index/journal JSON is never trusted:
 *
 * - canonical containment is the single source of truth for root agreement:
 *   BOTH the workspace root and the sidecar are canonicalized (realpath) before
 *   comparison, so two lexical aliases of one directory (e.g. `/var/...` and
 *   `/private/var/...` on macOS) agree, while a genuine escape is rejected.
 *   A raw `resolve()` output is never compared against a `realpath()` output;
 * - when the raw root and raw target are lexically nested, every existing
 *   component on the target path is additionally walked with `lstat` and any
 *   symlink / reparse component is rejected, so a link is never followed to
 *   delete a target elsewhere;
 * - canonical containment still rejects a path that is lexically inside but
 *   canonically outside (via a symlink).
 *
 * The returned lock path is always `<sidecar>/.lock` beneath the canonical
 * sidecar. This fails closed: any uncertainty resolves to DM_UNSAFE_PATH and
 * the lock is never touched.
 */
export async function verifyTrustedLockTarget(
  opts: {
    workspaceRoot: string;
    missionId: MissionId;
    sidecarPath: string;
  } & VerifyTrustedLockTargetOptions,
): Promise<TrustedLockTarget> {
  const canonicalize = opts.canonicalize ?? realpathOrResolve;
  const rootRaw = resolve(opts.workspaceRoot);
  const targetRaw = resolve(opts.sidecarPath);

  // Raw symlink/reparse rejection applies only when the raw forms are lexically
  // nested; when they are distinct aliases the canonical containment below is
  // authoritative.
  if (isWithin(rootRaw, targetRaw)) {
    await assertNoSymlinkComponents(rootRaw, targetRaw);
  }

  const rootCanon = await canonicalize(rootRaw);
  const targetCanon = await canonicalize(targetRaw);
  if (!isWithin(rootCanon, targetCanon)) {
    throw unsafeRecoveryPathError(targetRaw, "sidecar resolves outside the managed workspace root");
  }

  const lockPath = join(targetCanon, ".lock");
  if (!isWithin(targetCanon, lockPath)) {
    throw unsafeRecoveryPathError(lockPath, "lock path is not beneath the trusted sidecar");
  }

  return { sidecarPath: targetCanon, lockPath };
}
