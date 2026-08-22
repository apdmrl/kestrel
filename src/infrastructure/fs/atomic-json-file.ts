import { randomUUID } from "node:crypto";
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ZodType } from "zod";
import { createKestrelError } from "../../application/errors/kestrel-error.js";
export interface AtomicWriteOptions {
  /**
   * Override the directory fsync performed after the rename. Used by tests and
   * platforms that must control durability explicitly.
   */
  readonly fsyncDirectory?: (directoryPath: string) => Promise<void>;
}

const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set(["EINVAL", "EPERM", "ENOTSUP", "EISDIR", "EBADF"]);

function isUnsupportedDirectorySync(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code !== undefined && UNSUPPORTED_DIRECTORY_SYNC_CODES.has(code);
}

/**
 * Codes that indicate the rename target is briefly held open by another process
 * (a just-exited sibling process whose handle is still being released). Windows
 * reports EPERM/EACCES/EBUSY here; POSIX normally succeeds, but a bounded retry
 * is harmless there too. The target is never modified on a failed rename, so
 * retrying with a fresh temp file and the same intended value is idempotent and
 * safe: it can never install a different value than the one requested.
 */
const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

const RENAME_RETRY_ATTEMPTS = 20;
const RENAME_RETRY_DELAY_MS = 25;

function isRenameRetryable(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code !== undefined && RENAME_RETRY_CODES.has(code);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fsync the directory that contains a just-renamed file so the rename itself is
 * durable. Some platforms/filesystems do not support fsync on a directory;
 * those failures are treated as a documented safe fallback (no error).
 */
async function fsyncParentDirectory(
  directoryPath: string,
  options?: AtomicWriteOptions,
): Promise<void> {
  if (options?.fsyncDirectory !== undefined) {
    await options.fsyncDirectory(directoryPath);
    return;
  }
  let handle;
  try {
    handle = await open(directoryPath, "r");
    await handle.sync();
  } catch (error) {
    if (isUnsupportedDirectorySync(error)) {
      return;
    }
    throw error;
  } finally {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
  }
}

function corruptError(message: string) {
  return createKestrelError({
    code: "DM_STATE_CORRUPTED",
    category: "RECOVERABLE_STATE",
    userMessage: message,
    suggestedActions: ["Restore from the automatic backup, or remove the corrupt file"],
    retryability: "NO_RETRY",
    recoveryStrategy: "MANUAL_INTERVENTION",
    severity: "ERROR",
  });
}

/**
 * Atomically replace the target path with a JSON serialization of the value,
 * validated against the given schema. A failure before the rename never
 * truncates or replaces a previously valid primary file.
 *
 * A failure of the post-rename directory fsync is modeled as durability
 * uncertainty, not as a failed write: the rename has already made the intended
 * value the visible state, so the function reconciles by reading the target
 * back. When the intended value is verifiably installed, the write is reported
 * as successful (a retry would be idempotent and could not create a different
 * mission, recommendation, index entry, transaction intent, or checkpoint).
 * Only when reconciliation cannot confirm installation does the function
 * report an ordinary DM_STATE_WRITE_FAILED.
 */
export async function writeJsonAtomically<T>(
  path: string,
  value: unknown,
  schema: ZodType<T>,
  options?: AtomicWriteOptions,
): Promise<void> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw corruptError("Refusing to write state that fails schema validation");
  }
  const serialized = JSON.stringify(parsed.data, null, 2) + "\n";
  const tempPath = path + "." + randomUUID() + ".tmp";
  let handle;
  let renameCommitted = false;
  try {
    handle = await open(tempPath, "w");
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameWithRetry(tempPath, path);
    renameCommitted = true;
    await fsyncParentDirectory(dirname(path), options);
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await unlink(tempPath).catch(() => undefined);
    if (renameCommitted && (await reconcileInstalled(path, serialized))) {
      // The rename committed before the directory fsync failed and the
      // intended value is verifiably installed: the write is committed, even
      // though the directory entry's power-loss durability is best-effort.
      return;
    }
    throw createKestrelError({
      code: "DM_STATE_WRITE_FAILED",
      category: "TRANSIENT",
      userMessage: "Failed to persist state",
      suggestedActions: ["Retry the operation"],
      retryability: "RETRYABLE",
      recoveryStrategy: "RETRY",
      severity: "ERROR",
      cause: error,
    });
  }
}

/**
 * Rename a fully-written, synced temp file over its target, retrying a bounded
 * number of times when the target is transiently held open (Windows
 * EPERM/EACCES/EBUSY from a just-exited process). A failed rename never consumes
 * or mutates the temp file or the target, so retrying installs exactly the
 * intended value and is idempotent.
 */
async function renameWithRetry(tempPath: string, path: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tempPath, path);
      return;
    } catch (error) {
      if (!isRenameRetryable(error) || attempt >= RENAME_RETRY_ATTEMPTS - 1) {
        throw error;
      }
      await sleep(RENAME_RETRY_DELAY_MS);
    }
  }
}

/** Prove whether the intended serialized value is the visible target content. */
async function reconcileInstalled(path: string, expected: string): Promise<boolean> {
  try {
    return (await readFile(path, "utf8")) === expected;
  } catch {
    return false;
  }
}

/**
 * Read and validate a JSON file. Returns undefined when the file is absent, and
 * backs up corrupt content to a sibling .corrupt-<timestamp> file before throwing
 * a classified DM_STATE_CORRUPTED error.
 */
export async function readValidatedJson<T>(
  path: string,
  schema: ZodType<T>,
): Promise<T | undefined> {
  let buffer: Buffer;
  try {
    buffer = await readFile(path);
  } catch (error) {
    if (isEnoent(error)) {
      return undefined;
    }
    throw createKestrelError({
      code: "DM_STATE_READ_FAILED",
      category: "TRANSIENT",
      userMessage: "Failed to read persisted state",
      suggestedActions: ["Retry the operation"],
      retryability: "RETRYABLE",
      recoveryStrategy: "RETRY",
      severity: "ERROR",
      cause: error,
    });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(buffer.toString("utf8"));
  } catch {
    await backupCorrupt(path, buffer);
    throw corruptError("Persisted state is not valid JSON");
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    await backupCorrupt(path, buffer);
    throw corruptError("Persisted state failed schema validation");
  }
  return parsed.data;
}

async function backupCorrupt(path: string, buffer: Buffer): Promise<void> {
  const backupPath = path + ".corrupt-" + Date.now();
  try {
    await writeFile(backupPath, buffer);
  } catch {
    // Best-effort backup; the classified error still propagates.
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT"
  );
}
