import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { createKestrelError } from "../../application/errors/kestrel-error.js";
import type { MissionId } from "../../domain/shared/identifiers.js";
import type { IsoDateTime } from "../../domain/shared/time.js";
import type { MissionLock } from "../../ports/mission-lock.js";
import {
  defaultIsProcessAlive,
  readProcessIdentity,
  type ProcessIdentity,
} from "../system/process-liveness.js";

const identitySchema = z.object({
  bootId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  startTicks: z.string().regex(/^\d+$/),
});

const lockFileSchema = z.object({
  schemaVersion: z.literal(1),
  missionId: z.string().min(1),
  pid: z.number().int().positive(),
  createdAt: z.string().min(1),
  operation: z.string().min(1),
  token: z.string().min(1),
  identity: identitySchema.optional(),
});

type LockFile = z.infer<typeof lockFileSchema>;

const guardFileSchema = z.object({
  schemaVersion: z.literal(1),
  pid: z.number().int().positive(),
  createdAt: z.string().min(1),
  token: z.string().min(1),
  identity: identitySchema.optional(),
});

type GuardFile = z.infer<typeof guardFileSchema>;

/**
 * Liveness probe for an owning process; injectable for deterministic tests.
 * Receives the owner's recorded stable identity (boot id + start ticks) so it
 * can detect OS pid reuse by exact identity match. Legacy records without an
 * identity pass `undefined`.
 */
export type ProcessLiveness = (
  pid: number,
  ownerIdentity: ProcessIdentity | undefined,
) => boolean | Promise<boolean>;

export interface FileMissionLockOptions {
  /** Liveness probe; defaults to a signal-zero check plus a pid-reuse guard. */
  isProcessAlive?: ProcessLiveness;
  /**
   * Deterministic test hook: fired after the guard reservation (owner record)
   * is fully written but before the atomic rename commits it. Lets a test
   * pause an acquisition between reservation and finalized ownership.
   */
  onGuardReserved?: (guardPath: string, token: string) => Promise<void> | void;
  /**
   * Deterministic test hook: fired when a guard's owner is judged dead, just
   * before the dead owner's record is removed. Lets a test pause a recovery
   * contender between reading a dead owner and breaking its guard.
   */
  onDeadGuardOwner?: (guardPath: string, deadToken: string) => Promise<void> | void;
}

function isEexist(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "EEXIST"
  );
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT"
  );
}

function lockedError(pid: number) {
  return createKestrelError({
    code: "DM_MISSION_LOCKED",
    category: "CONFLICT",
    userMessage: "Mission is locked by another process",
    suggestedActions: ["Wait for the other operation to finish"],
    retryability: "NO_RETRY",
    recoveryStrategy: "USER_ACTION",
    severity: "ERROR",
    debugContext: { pid },
  });
}

function staleLockError(pid: number) {
  return createKestrelError({
    code: "DM_MISSION_LOCK_STALE",
    category: "RECOVERABLE_STATE",
    userMessage: "Mission lock is held by a process that is no longer running",
    suggestedActions: ["Run 'kestrel mission break-lock' to recover the lock"],
    retryability: "NO_RETRY",
    recoveryStrategy: "USER_ACTION",
    severity: "WARNING",
    debugContext: { pid },
  });
}

function malformedLockError() {
  return createKestrelError({
    code: "DM_STATE_CORRUPTED",
    category: "RECOVERABLE_STATE",
    userMessage: "Mission lock file is malformed",
    suggestedActions: ["Remove or repair the lock file"],
    retryability: "NO_RETRY",
    recoveryStrategy: "MANUAL_INTERVENTION",
    severity: "ERROR",
    debugContext: {},
  });
}

function ioError(message: string, cause: unknown) {
  return createKestrelError({
    code: "DM_STATE_WRITE_FAILED",
    category: "TRANSIENT",
    userMessage: message,
    suggestedActions: ["Retry the operation"],
    retryability: "RETRYABLE",
    recoveryStrategy: "RETRY",
    severity: "ERROR",
    cause,
  });
}

/**
 * Mission single-writer lock.
 *
 * The lock file itself records the owner (pid + token). Every mutation of that
 * file — acquisition, release, and stale recovery — is serialized through a
 * separate recovery-guard directory. Node.js exposes no dependable OS advisory
 * lock (flock) in core, so the guard uses directory-based locking with atomic
 * commit evidence:
 *
 * 1. The contender writes its full owner record (pid + random token) into a
 *    uniquely named reservation directory that is invisible to other
 *    contenders (guardPath + "." + token + ".tmp").
 * 2. The reservation is committed with a single atomic rename() onto the guard
 *    path. After commit the guard directory always contains a complete,
 *    schema-valid, token-named owner record — an ownerless or malformed guard
 *    directory can therefore never be produced by a live process and is
 *    provably crash residue that can be reclaimed deterministically.
 * 3. Removal is content- and token-conditional: a recovery contender only
 *    unlinks records whose embedded token matches the dead owner it observed,
 *    and the directory is removed only with rmdir (which succeeds only when
 *    empty). A replacement owner's record (different token) can never be
 *    deleted by an old releaser or a slow recovery contender, even under
 *    arbitrary interleavings.
 *
 * The lock file is therefore never removed or replaced before exclusive
 * recovery ownership has been established, and a live owner is always left
 * authoritative.
 */
export class FileMissionLock implements MissionLock {
  private readonly isProcessAlive: ProcessLiveness;
  private readonly onGuardReserved:
    ((guardPath: string, token: string) => Promise<void> | void) | undefined;
  private readonly onDeadGuardOwner:
    ((guardPath: string, deadToken: string) => Promise<void> | void) | undefined;

  constructor(options: FileMissionLockOptions = {}) {
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    this.onGuardReserved = options.onGuardReserved;
    this.onDeadGuardOwner = options.onDeadGuardOwner;
  }

  async withMissionLock<T>(
    lockPath: string,
    missionId: MissionId,
    operation: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const token = randomUUID();
    await mkdir(dirname(lockPath), { recursive: true });
    const guardPath = this.guardPath(lockPath);
    const guardToken = await this.acquireGuard(guardPath);
    try {
      let handle;
      try {
        handle = await open(lockPath, "wx");
      } catch (error) {
        if (isEexist(error)) {
          throw await this.classifyExistingLock(lockPath);
        }
        throw ioError("Failed to acquire the mission lock", error);
      }

      const identity = readProcessIdentity(process.pid);
      const content =
        JSON.stringify(
          {
            schemaVersion: 1,
            missionId,
            pid: process.pid,
            createdAt: new Date().toISOString() as IsoDateTime,
            operation,
            token,
            ...(identity !== undefined ? { identity } : {}),
          },
          null,
          2,
        ) + "\n";

      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
        throw ioError("Failed to write the mission lock", error);
      }
      await handle.close();

      // The guard is held for the entire critical section, so release never has
      // to re-acquire it and can never leak the lock file under contention.
      try {
        return await action();
      } finally {
        await this.releaseLock(lockPath, token);
      }
    } finally {
      await this.releaseGuard(guardPath, guardToken);
    }
  }

  async breakStaleLock(lockPath: string, expectedMissionId?: MissionId): Promise<void> {
    await mkdir(dirname(lockPath), { recursive: true });
    const guardPath = this.guardPath(lockPath);
    const guardToken = await this.acquireGuard(guardPath);
    try {
      const current = await this.readLock(lockPath);
      if (current === undefined) {
        return;
      }
      if (expectedMissionId !== undefined && current.missionId !== expectedMissionId) {
        // The lock at this path belongs to a different mission: fail closed and
        // never delete it. The target was already verified to be inside the
        // managed workspace root by the caller.
        throw createKestrelError({
          code: "DM_UNSAFE_PATH",
          category: "INVALID_INPUT",
          userMessage: "The mission lock does not match the requested mission",
          suggestedActions: ["Inspect the mission index and pending transactions"],
          retryability: "NO_RETRY",
          recoveryStrategy: "MANUAL_INTERVENTION",
          severity: "ERROR",
          debugContext: { path: lockPath, expectedMissionId, foundMissionId: current.missionId },
        });
      }
      if (await this.isProcessAlive(current.pid, current.identity)) {
        throw lockedError(current.pid);
      }
      await unlink(lockPath);
    } finally {
      await this.releaseGuard(guardPath, guardToken);
    }
  }

  private guardPath(lockPath: string): string {
    return lockPath + ".guard";
  }

  /**
   * Guard reservation, committed with a single atomic rename. The owner record
   * is fully written (and, for tests, optionally paused) before the rename, so
   * the guard path never exists without a complete, valid owner record.
   */
  private async acquireGuard(guardPath: string): Promise<string> {
    const token = randomUUID();
    const reservationDir = guardPath + "." + token + ".tmp";
    try {
      await mkdir(reservationDir);
      await this.writeGuardOwner(reservationDir, token);
      await this.onGuardReserved?.(guardPath, token);

      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          await rename(reservationDir, guardPath);
          return token;
        } catch (error) {
          if (!this.isGuardConflict(error)) {
            throw ioError("Failed to acquire the mission lock guard", error);
          }
        }

        const inspected = await this.inspectGuard(guardPath);
        if (inspected.kind === "gone") {
          continue; // Freed by a concurrent release; retry the rename.
        }
        if (inspected.kind === "owner") {
          if (await this.isProcessAlive(inspected.owner.pid, inspected.owner.identity)) {
            throw lockedError(inspected.owner.pid);
          }
          await this.onDeadGuardOwner?.(guardPath, inspected.owner.token);
          await this.breakGuard(guardPath, inspected.owner);
          continue;
        }
        // Ownerless or malformed entries are provably crash residue under this
        // protocol (a live owner always commits a complete, valid record).
        await this.removeResidue(guardPath, inspected);
      }
      throw lockedError(process.pid);
    } finally {
      await rm(reservationDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private isGuardConflict(error: unknown): boolean {
    if (typeof error !== "object" || error === null) {
      return false;
    }
    const code = (error as { code?: string }).code;
    return code === "EEXIST" || code === "ENOTEMPTY" || code === "ENOTDIR";
  }

  private async writeGuardOwner(directory: string, token: string): Promise<void> {
    const identity = readProcessIdentity(process.pid);
    const content =
      JSON.stringify(
        {
          schemaVersion: 1,
          pid: process.pid,
          createdAt: new Date().toISOString() as IsoDateTime,
          token,
          ...(identity !== undefined ? { identity } : {}),
        },
        null,
        2,
      ) + "\n";
    await writeFile(join(directory, "owner-" + token + ".json"), content, {
      encoding: "utf8",
      flag: "wx",
    });
  }

  private parseGuardOwner(content: string): GuardFile | undefined {
    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      return undefined;
    }
    const parsed = guardFileSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  }

  private async inspectGuard(
    guardPath: string,
  ): Promise<
    | { kind: "gone" }
    | { kind: "owner"; owner: GuardFile }
    | { kind: "residue"; entries: string[] | null }
  > {
    let entries: string[];
    try {
      entries = await readdir(guardPath);
    } catch (error) {
      if (isEnoent(error)) {
        return { kind: "gone" };
      }
      if ((error as { code?: string }).code === "ENOTDIR") {
        // The guard path itself is a file, not a directory: residue.
        return { kind: "residue", entries: null };
      }
      throw ioError("Failed to inspect the mission lock guard", error);
    }
    const junk: string[] = [];
    let owner: GuardFile | undefined;
    for (const entry of entries) {
      let content: string;
      try {
        content = await readFile(join(guardPath, entry), "utf8");
      } catch (error) {
        if (isEnoent(error)) {
          continue; // Raced away; re-inspect on the next attempt.
        }
        throw ioError("Failed to read a mission lock guard record", error);
      }
      const parsed = this.parseGuardOwner(content);
      if (parsed === undefined) {
        junk.push(entry);
      } else {
        owner ??= parsed;
      }
    }
    if (owner !== undefined) {
      return { kind: "owner", owner };
    }
    return { kind: "residue", entries: junk };
  }

  /** Remove a dead owner's guard record by token, then the directory if empty. */
  private async breakGuard(guardPath: string, deadOwner: GuardFile): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(guardPath);
    } catch (error) {
      if (isEnoent(error)) {
        return;
      }
      if ((error as { code?: string }).code === "ENOTDIR") {
        await unlink(guardPath).catch(() => undefined);
        return;
      }
      throw ioError("Failed to read the mission lock guard during recovery", error);
    }
    for (const entry of entries) {
      let content: string;
      try {
        content = await readFile(join(guardPath, entry), "utf8");
      } catch (error) {
        if (isEnoent(error)) {
          continue;
        }
        throw ioError("Failed to read a mission lock guard record during recovery", error);
      }
      const parsed = this.parseGuardOwner(content);
      if (parsed !== undefined && parsed.token !== deadOwner.token) {
        continue; // A replacement owner's record: never touch it.
      }
      // The dead owner's record or unparseable junk from a crashed writer.
      await unlink(join(guardPath, entry)).catch(() => undefined);
    }
    await rmdir(guardPath).catch(() => undefined); // ENOTEMPTY: a replacement owns it now.
  }

  /** Remove provably-abandoned residue: junk entries and an empty/absent directory. */
  private async removeResidue(
    guardPath: string,
    residue: { entries: string[] | null },
  ): Promise<void> {
    if (residue.entries === null) {
      // The guard path itself is a file, not a directory.
      await unlink(guardPath).catch(() => undefined);
      return;
    }
    for (const entry of residue.entries) {
      const entryPath = join(guardPath, entry);
      await unlink(entryPath).catch(async (error) => {
        if (isEnoent(error)) {
          return;
        }
        await rmdir(entryPath).catch(() => undefined); // Entry is a stray directory.
      });
    }
    await rmdir(guardPath).catch(() => undefined); // ENOTEMPTY: something re-created it; retry.
  }

  /**
   * Release only the record this process created (token-named). A replacement
   * owner's record has a different token and is never unlinked; rmdir then
   * fails with ENOTEMPTY and leaves the replacement guard intact.
   */
  private async releaseGuard(guardPath: string, token: string): Promise<void> {
    await unlink(join(guardPath, "owner-" + token + ".json")).catch(() => undefined);
    await rmdir(guardPath).catch(() => undefined);
  }

  private async classifyExistingLock(lockPath: string) {
    const current = await this.readLock(lockPath);
    if (current === undefined) {
      return lockedError(process.pid);
    }
    if (await this.isProcessAlive(current.pid, current.identity)) {
      return lockedError(current.pid);
    }
    return staleLockError(current.pid);
  }

  /** Remove the lock file if we still own it. The guard is already held. */
  private async releaseLock(lockPath: string, token: string): Promise<void> {
    const current = await this.readLock(lockPath);
    if (current === undefined || current.token !== token) {
      return;
    }
    await unlink(lockPath);
  }

  private async readLock(lockPath: string): Promise<LockFile | undefined> {
    let content: string;
    try {
      content = await readFile(lockPath, "utf8");
    } catch (error) {
      if (isEnoent(error)) {
        return undefined;
      }
      throw ioError("Failed to read the mission lock", error);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      throw malformedLockError();
    }
    const parsed = lockFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw malformedLockError();
    }
    return parsed.data;
  }
}
