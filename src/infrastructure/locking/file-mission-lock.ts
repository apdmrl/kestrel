import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
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

function isProcessAlive(pid: number): boolean {
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

export class FileMissionLock implements MissionLock {
  async withMissionLock<T>(
    lockPath: string,
    missionId: MissionId,
    operation: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const token = randomUUID();
    await mkdir(dirname(lockPath), { recursive: true });
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

    try {
      return await action();
    } finally {
      await this.release(lockPath, token);
    }
  }

  async breakStaleLock(lockPath: string): Promise<void> {
    const current = await this.readLock(lockPath);
    if (current === undefined) {
      return;
    }
    if (isProcessAlive(current.pid)) {
      throw lockedError(current.pid);
    }
    await unlink(lockPath);
  }

  private async classifyExistingLock(lockPath: string) {
    const current = await this.readLock(lockPath);
    if (current === undefined) {
      return lockedError(process.pid);
    }
    if (isProcessAlive(current.pid)) {
      return lockedError(current.pid);
    }
    return staleLockError(current.pid);
  }

  private async release(lockPath: string, token: string): Promise<void> {
    const current = await this.readLock(lockPath);
    if (current === undefined) {
      return;
    }
    if (current.token !== token) {
      return;
    }
    await unlink(lockPath).catch(() => undefined);
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
