import { readFileSync } from "node:fs";
import { platform } from "node:os";

/**
 * Stable kernel identity of a process: the system boot id plus the process's
 * start-time tick count. Together these uniquely identify a process instance and
 * let us detect OS pid reuse without relying on filesystem timestamps or
 * wall-clock conversion.
 */
export interface ProcessIdentity {
  readonly bootId: string;
  readonly startTicks: string;
}

const BOOT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const START_TICKS_RE = /^\d+$/;

/**
 * Whether a process identity is in the canonical format: a UUID-shaped boot id
 * and a non-negative decimal start-ticks string. A syntactically malformed
 * identity is untrustworthy and must never authorize a destructive decision.
 */
export function isWellFormedIdentity(identity: ProcessIdentity): boolean {
  return BOOT_ID_RE.test(identity.bootId) && START_TICKS_RE.test(identity.startTicks);
}

/**
 * Parse field 22 (starttime, in clock ticks since boot) from a `/proc/<pid>/stat`
 * line. The command field may itself contain spaces and `)`, so the state fields
 * are located by the *last* `)` before the fixed tail. After that `)` the first
 * token is field 3 (state), so field 22 is the 20th token (index 19). Ticks are
 * preserved as a decimal string; never converted through floating point.
 */
export function parseStartTicks(stat: string): string | undefined {
  const closeParen = stat.lastIndexOf(")");
  if (closeParen === -1) {
    return undefined;
  }
  const rest = stat.slice(closeParen + 2).split(" ");
  const startTicks = rest[19];
  return startTicks === undefined || startTicks.length === 0 ? undefined : startTicks;
}

/**
 * Read the stable identity of the process with the given pid. Returns undefined
 * on platforms without a `/proc` interface or when the process is absent.
 */
export function readProcessIdentity(pid: number): ProcessIdentity | undefined {
  if (platform() !== "linux") {
    return undefined;
  }
  try {
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const startTicks = parseStartTicks(readFileSync("/proc/" + pid + "/stat", "utf8"));
    if (startTicks === undefined) {
      return undefined;
    }
    return { bootId, startTicks };
  } catch {
    return undefined;
  }
}

/**
 * Default liveness probe used by the mission lock.
 *
 * A pid is dead when a null signal reports it gone. When the pid is alive, the
 * recorded owner identity (if any) is compared against the current process's
 * stable identity: an exact match is live, a mismatch is stale (pid reused).
 * If the owner record predates identity (legacy) the live pid is conservatively
 * treated as live, and if a live pid's identity cannot be read the lock is
 * preserved rather than risk breaking a live owner.
 */
export function defaultIsProcessAlive(
  pid: number,
  ownerIdentity: ProcessIdentity | undefined,
): boolean {
  let alive: boolean;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch (error) {
    alive = (error as { code?: string }).code === "EPERM";
  }
  if (!alive) {
    return false;
  }
  if (ownerIdentity === undefined) {
    return true;
  }
  // A malformed or unreadable identity for an otherwise live pid is treated as
  // unknown/live and must never authorize deletion (fail closed).
  if (!isWellFormedIdentity(ownerIdentity)) {
    return true;
  }
  const current = readProcessIdentity(pid);
  if (current === undefined) {
    return true;
  }
  return current.bootId === ownerIdentity.bootId && current.startTicks === ownerIdentity.startTicks;
}
