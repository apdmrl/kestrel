import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  RecoveryBarrier,
  RecoveryBoundary,
} from "../../application/transactions/recovery-barrier.js";
import type { MissionId } from "../../domain/shared/identifiers.js";

function markerName(boundary: RecoveryBoundary, missionId: MissionId): string {
  return (
    boundary.replace(/[^A-Za-z0-9._-]/g, "_") + "__" + missionId.replace(/[^A-Za-z0-9._-]/g, "_")
  );
}

/**
 * Deterministic crash barrier used only by built-CLI recovery tests. Each
 * matching call writes a marker file (so the test knows the boundary was
 * reached) and then blocks until a release byte arrives on a FIFO. The owning
 * process is typically SIGKILLed at the marker, reproducing a crash exactly
 * after a durable write. Boundaries outside an optional `matchPrefix` pass
 * through without blocking.
 */
export class FifoRecoveryBarrier implements RecoveryBarrier {
  constructor(
    private readonly markerDir: string,
    private readonly releaseFifo: string,
    private readonly matchPrefix?: string,
  ) {}

  async reach(boundary: RecoveryBoundary, missionId: MissionId): Promise<void> {
    if (this.matchPrefix !== undefined && !boundary.startsWith(this.matchPrefix)) {
      return;
    }
    await mkdir(this.markerDir, { recursive: true });
    await writeFile(join(this.markerDir, markerName(boundary, missionId)), "reached\n", "utf8");
    // Block until the test writes a release byte (or the process is terminated).
    await new Promise<void>((resolve) => {
      open(this.releaseFifo, "r").then(
        async (handle) => {
          try {
            await readFile(handle);
          } catch {
            // FIFO abandoned; the owning process is typically being terminated.
          }
          resolve();
        },
        () => resolve(),
      );
    });
  }
}
