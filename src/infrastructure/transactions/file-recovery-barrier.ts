import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  RecoveryBarrier,
  RecoveryBoundary,
} from "../../application/transactions/recovery-barrier.js";
import type { MissionId } from "../../domain/shared/identifiers.js";
import { lstat } from "node:fs/promises";

function markerName(boundary: RecoveryBoundary, missionId: MissionId): string {
  return (
    boundary.replace(/[^A-Za-z0-9._-]/g, "_") + "__" + missionId.replace(/[^A-Za-z0-9._-]/g, "_")
  );
}

async function isEnoent(error: unknown): Promise<boolean> {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT"
  );
}

/**
 * Deterministic crash barrier used only by built-CLI recovery tests. Each
 * matching call writes a marker file (so the test knows the boundary was
 * reached) and then blocks until a release file appears on disk. The owning
 * process is typically SIGKILLed at the marker, reproducing a crash exactly
 * after a durable write. Boundaries outside an optional `matchPrefix` pass
 * through without blocking.
 *
 * This uses a file existence gate (polled with setImmediate, never a wall-clock
 * sleep) instead of a POSIX FIFO so the exact same barrier is usable on
 * Windows, macOS, and Linux. A never-released gate simply blocks forever, which
 * is how a crash is simulated.
 */
export class FileRecoveryBarrier implements RecoveryBarrier {
  constructor(
    private readonly markerDir: string,
    private readonly releaseFile: string,
    private readonly matchPrefix?: string,
  ) {}

  async reach(boundary: RecoveryBoundary, missionId: MissionId): Promise<void> {
    if (this.matchPrefix !== undefined && !boundary.startsWith(this.matchPrefix)) {
      return;
    }
    await mkdir(this.markerDir, { recursive: true });
    await writeFile(join(this.markerDir, markerName(boundary, missionId)), "reached\n", "utf8");
    // Block (deterministically, with no sleeps) until the test releases the
    // gate by creating the release file, or the owning process is terminated.
    for (;;) {
      let exists: boolean;
      try {
        await lstat(this.releaseFile);
        exists = true;
      } catch (error) {
        if (await isEnoent(error)) {
          exists = false;
        } else {
          exists = true; // Unreadable is treated as released to avoid hanging.
        }
      }
      if (exists) {
        return;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
}
