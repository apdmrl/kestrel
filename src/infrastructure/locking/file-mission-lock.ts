import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { createKestrelError } from "../../application/errors/kestrel-error.js";
import type { MissionId } from "../../domain/shared/identifiers.js";
import type { IsoDateTime } from "../../domain/shared/time.js";
import type { MissionLock } from "../../ports/mission-lock.js";

const lockFileSchema = z.object({
  schemaVersion: z.literal(1),
  missionId: z.string().min(1),
  pid: z.number().int().positive(),
  createdAt: z.string().min(1),
  operation: z.string().min(1),
  token: z.string().min(1),
});

type LockFile = z.infer<typeof lockFileSchema>;

const guardFileSchema = z.object({
  schemaVersion: z.literal(1),
  pid: z.number().int().positive(),
  createdAt: z.string().min(1),
  token: z.string().min(1),
});

type GuardFile = z.infer<typeof guardFileSchema>;

/** Liveness probe for an owning process; injectable for deterministic tests. */
export type ProcessLiveness = (pid: number) => boolean | Promise<boolean>;

export interface FileMissionLockOptions {
  /** Liveness probe; defaults to a null-signal check against the process table. */
  isProcessAlive?: ProcessLiveness;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
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
    suggestedActions: ["Run breakStaleLock to recover the lock"],
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
 * separate recovery-guard directory. The guard directory is created atomically
 * with mkdir and removed with rmdir (which only succeeds when empty), so it is
 * never "renamed away" to expose a window in which a second writer can slip
 * in. The lock file is therefore never removed or replaced before exclusive
 * recovery ownership has been established, and a live owner is always left
 * authoritative.
 */
export class FileMissionLock implements MissionLock {
  private readonly isProcessAlive: ProcessLiveness;

  constructor(options: FileMissionLockOptions = {}) {
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
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

      const content =
        JSON.stringify(
          {
            schemaVersion: 1,
            missionId,
            pid: process.pid,
            createdAt: new Date().toISOString() as IsoDateTime,
            operation,
            token,
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
    } finally {
      await this.releaseGuard(guardPath, guardToken);
    }

    try {
      return await action();
    } finally {
      await this.release(lockPath, token);
    }
  }

  async breakStaleLock(lockPath: string): Promise<void> {
    await mkdir(dirname(lockPath), { recursive: true });
    const guardPath = this.guardPath(lockPath);
    const guardToken = await this.acquireGuard(guardPath);
    try {
      const current = await this.readLock(lockPath);
      if (current === undefined) {
        return;
      }
      if (await this.isProcessAlive(current.pid)) {
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

  private async acquireGuard(guardPath: string): Promise<string> {
    const token = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await mkdir(guardPath);
      } catch (error) {
        if (!isEexist(error)) {
          throw ioError("Failed to acquire the mission lock guard", error);
        }
        const owner = await this.readGuardOwner(guardPath);
        if (owner !== undefined && (await this.isProcessAlive(owner.pid))) {
          throw lockedError(owner.pid);
        }
        await this.breakGuard(guardPath);
        continue;
      }
      try {
        await this.writeGuardOwner(guardPath, token);
        return token;
      } catch (error) {
        await unlink(join(guardPath, "owner.json")).catch(() => undefined);
        await rmdir(guardPath).catch(() => undefined);
        throw ioError("Failed to write the mission lock guard", error);
      }
    }
    throw lockedError(process.pid);
  }

  private async writeGuardOwner(guardPath: string, token: string): Promise<void> {
    const content =
      JSON.stringify(
        {
          schemaVersion: 1,
          pid: process.pid,
          createdAt: new Date().toISOString() as IsoDateTime,
          token,
        },
        null,
        2,
      ) + "\n";
    await writeFile(join(guardPath, "owner.json"), content, { encoding: "utf8", flag: "wx" });
  }

  private async readGuardOwner(guardPath: string): Promise<GuardFile | undefined> {
    let content: string;
    try {
      content = await readFile(join(guardPath, "owner.json"), "utf8");
    } catch (error) {
      if (isEnoent(error)) {
        return undefined;
      }
      throw ioError("Failed to read the mission lock guard", error);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      return undefined;
    }
    const parsed = guardFileSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  }

  private async breakGuard(guardPath: string): Promise<void> {
    await unlink(join(guardPath, "owner.json")).catch(() => undefined);
    await rmdir(guardPath).catch(() => undefined);
  }

  private async releaseGuard(guardPath: string, token: string): Promise<void> {
    const owner = await this.readGuardOwner(guardPath).catch(() => undefined);
    if (owner !== undefined && owner.token !== token) {
      return;
    }
    await unlink(join(guardPath, "owner.json")).catch(() => undefined);
    await rmdir(guardPath).catch(() => undefined);
  }

  private async classifyExistingLock(lockPath: string) {
    const current = await this.readLock(lockPath);
    if (current === undefined) {
      return lockedError(process.pid);
    }
    if (await this.isProcessAlive(current.pid)) {
      return lockedError(current.pid);
    }
    return staleLockError(current.pid);
  }

  private async release(lockPath: string, token: string): Promise<void> {
    const guardPath = this.guardPath(lockPath);
    let guardToken: string;
    try {
      guardToken = await this.acquireGuard(guardPath);
    } catch {
      return;
    }
    try {
      const current = await this.readLock(lockPath);
      if (current === undefined || current.token !== token) {
        return;
      }
      await unlink(lockPath);
    } finally {
      await this.releaseGuard(guardPath, guardToken);
    }
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
