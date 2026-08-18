import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MissionId } from "../../domain/shared/identifiers.js";
import { FileMissionLock } from "./file-mission-lock.js";

const missionId = "m1" as MissionId;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kestrel-lock-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function lockPath(): string {
  return join(dir, "kestrel", ".lock");
}

async function writeLock(content: string): Promise<void> {
  await mkdir(join(dir, "kestrel"), { recursive: true });
  await writeFile(lockPath(), content, "utf8");
}

function staleLockContent(pid: number): string {
  return (
    JSON.stringify({
      schemaVersion: 1,
      missionId,
      pid,
      createdAt: "2026-08-15T10:00:00Z",
      operation: "complete",
      token: "stale-token",
    }) + "\n"
  );
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error("expected rejection");
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
  }
}

/**
 * Deterministic synchronization barrier: yield to the event loop until a
 * condition holds or a bounded yield budget is exhausted. No wall-clock sleep
 * is involved, so the result cannot flake with machine speed.
 */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition not reached before the bounded yield budget");
}

describe("FileMissionLock", () => {
  it("acquires exclusively and releases on success", async () => {
    const lock = new FileMissionLock();
    let ran = false;
    const result = await lock.withMissionLock(lockPath(), missionId, "complete", async () => {
      ran = true;
      return "done";
    });
    expect(result).toBe("done");
    expect(ran).toBe(true);
    await expect(stat(lockPath())).rejects.toThrow();
  });

  it("releases on error and rethrows", async () => {
    const lock = new FileMissionLock();
    await expect(
      lock.withMissionLock(lockPath(), missionId, "complete", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(stat(lockPath())).rejects.toThrow();
  });

  it("rejects a second live owner", async () => {
    const lock = new FileMissionLock();
    await lock.withMissionLock(lockPath(), missionId, "complete", async () => {
      await expectCode(
        lock.withMissionLock(lockPath(), missionId, "other", async () => undefined),
        "DM_MISSION_LOCKED",
      );
    });
  });

  it("detects a stale owner and requires explicit recovery", async () => {
    await writeLock(staleLockContent(99999999));
    const lock = new FileMissionLock();
    await expectCode(
      lock.withMissionLock(lockPath(), missionId, "complete", async () => undefined),
      "DM_MISSION_LOCK_STALE",
    );
  });

  it("classifies a malformed lock file", async () => {
    await writeLock("{ not json");
    const lock = new FileMissionLock();
    await expectCode(
      lock.withMissionLock(lockPath(), missionId, "complete", async () => undefined),
      "DM_STATE_CORRUPTED",
    );
  });

  it("recovers a stale lock explicitly", async () => {
    await writeLock(staleLockContent(99999999));
    const lock = new FileMissionLock();
    await lock.breakStaleLock(lockPath());
    await expect(stat(lockPath())).rejects.toThrow();

    let ran = false;
    await lock.withMissionLock(lockPath(), missionId, "complete", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("does not break a live lock", async () => {
    const lock = new FileMissionLock();
    await lock.withMissionLock(lockPath(), missionId, "complete", async () => {
      await expectCode(lock.breakStaleLock(lockPath()), "DM_MISSION_LOCKED");
    });
  });

  it("converges when two stale-lock breakers race a new owner", async () => {
    await writeLock(staleLockContent(99999999));
    const lock = new FileMissionLock();
    const results = await Promise.allSettled([
      lock.breakStaleLock(lockPath()),
      lock.breakStaleLock(lockPath()),
    ]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);

    let ran = false;
    await lock.withMissionLock(lockPath(), missionId, "new", async () => {
      ran = true;
      await expectCode(lock.breakStaleLock(lockPath()), "DM_MISSION_LOCKED");
    });
    expect(ran).toBe(true);
    await expect(stat(lockPath())).rejects.toThrow();
  });

  it("restores a replacement lock instead of deleting it on release", async () => {
    const lock = new FileMissionLock();
    await lock.withMissionLock(lockPath(), missionId, "complete", async () => {
      // A different process replaces the lock file while we hold it.
      await writeLock(staleLockContent(99999998));
    });
    const raw = await readFile(lockPath(), "utf8");
    expect((JSON.parse(raw) as { token: string }).token).toBe("stale-token");
    await lock.breakStaleLock(lockPath());
  });

  it("keeps a live owner authoritative while recovery is paused mid-claim", async () => {
    const alivePid = 424242;
    let reached = false;
    let resume: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const lock = new FileMissionLock({
      isProcessAlive: (pid) => {
        if (pid === alivePid) {
          reached = true;
          return gate.then(() => true);
        }
        return true;
      },
    });
    await writeLock(staleLockContent(alivePid));

    const breaker = lock.breakStaleLock(lockPath());
    await waitFor(() => reached);

    // While recovery holds the claim, a second acquisition must be excluded.
    await expectCode(
      lock.withMissionLock(lockPath(), missionId, "other", async () => undefined),
      "DM_MISSION_LOCKED",
    );

    resume();
    await expectCode(breaker, "DM_MISSION_LOCKED");

    // The original live owner remains authoritative and untouched.
    const raw = JSON.parse(await readFile(lockPath(), "utf8")) as { pid: number };
    expect(raw.pid).toBe(alivePid);
  });

  it("lets exactly one stale-lock breaker recover and excludes the others", async () => {
    await writeLock(staleLockContent(99999999));
    let reached = false;
    let resume: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const first = new FileMissionLock({
      isProcessAlive: (pid) => {
        if (pid === 99999999) {
          reached = true;
          return gate.then(() => false);
        }
        return true;
      },
    });
    const breaker1 = first.breakStaleLock(lockPath());
    await waitFor(() => reached);

    const second = new FileMissionLock();
    await expectCode(second.breakStaleLock(lockPath()), "DM_MISSION_LOCKED");

    resume();
    await breaker1;
    await expect(stat(lockPath())).rejects.toThrow();
  });

  it("recovers an empty guard directory left as crash residue", async () => {
    // Crash residue from the pre-fix protocol: the guard directory exists but
    // the owner record was never written (or was lost). Acquisition must be
    // able to reclaim it deterministically.
    await mkdir(join(dir, "kestrel"), { recursive: true });
    await mkdir(lockPath() + ".guard");

    const lock = new FileMissionLock();
    let ran = false;
    await lock.withMissionLock(lockPath(), missionId, "complete", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    await expect(stat(lockPath())).rejects.toThrow();
  });

  it("recovers a truncated guard owner file left as crash residue", async () => {
    const guardDir = lockPath() + ".guard";
    await mkdir(join(dir, "kestrel"), { recursive: true });
    await mkdir(guardDir);
    await writeFile(join(guardDir, "owner.json"), "{ not json", "utf8");

    const lock = new FileMissionLock();
    let ran = false;
    await lock.withMissionLock(lockPath(), missionId, "complete", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    await expect(stat(lockPath())).rejects.toThrow();
  });

  it("recovers a schema-invalid guard owner file left as crash residue", async () => {
    const guardDir = lockPath() + ".guard";
    await mkdir(join(dir, "kestrel"), { recursive: true });
    await mkdir(guardDir);
    await writeFile(join(guardDir, "owner.json"), "{}", "utf8");

    const lock = new FileMissionLock();
    let ran = false;
    await lock.withMissionLock(lockPath(), missionId, "complete", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    await expect(stat(lockPath())).rejects.toThrow();
  });

  it("recovers an empty guard residue during stale-lock recovery", async () => {
    await writeLock(staleLockContent(99999999));
    await mkdir(lockPath() + ".guard");

    const lock = new FileMissionLock();
    await lock.breakStaleLock(lockPath());
    await expect(stat(lockPath())).rejects.toThrow();
  });

  it("lets exactly one recovery contender establish guard ownership", async () => {
    // Dead-owner residue: a guard directory whose owner record names a process
    // that is no longer running.
    const guardDir = lockPath() + ".guard";
    await mkdir(join(dir, "kestrel"), { recursive: true });
    await mkdir(guardDir);
    await writeFile(
      join(guardDir, "owner.json"),
      JSON.stringify({
        schemaVersion: 1,
        pid: 99999999,
        createdAt: "2026-08-15T10:00:00Z",
        token: "dead-token",
      }),
      "utf8",
    );

    let firstReached = false;
    let secondReached = false;
    let resumeFirst: () => void = () => undefined;
    let resumeSecond: () => void = () => undefined;
    const gate1 = new Promise<void>((resolve) => {
      resumeFirst = resolve;
    });
    const gate2 = new Promise<void>((resolve) => {
      resumeSecond = resolve;
    });

    const contender1 = new FileMissionLock({
      onDeadGuardOwner: async () => {
        firstReached = true;
        await gate1;
      },
    });
    const contender2 = new FileMissionLock({
      onDeadGuardOwner: async () => {
        secondReached = true;
        await gate2;
      },
    });

    let winnerHeld = false;
    let releaseWinner: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });

    const run1 = contender1.withMissionLock(lockPath(), missionId, "complete", async () => {
      winnerHeld = true;
      await hold;
    });
    const run2 = contender2.withMissionLock(
      lockPath(),
      missionId,
      "complete",
      async () => undefined,
    );

    await waitFor(() => firstReached && secondReached);

    // The first contender resumes and must establish ownership, entering the
    // critical section.
    resumeFirst();
    await waitFor(() => winnerHeld);

    // The second contender resumes and must be excluded: it may not delete the
    // winner's guard and may not enter the critical section.
    resumeSecond();
    await expectCode(run2, "DM_MISSION_LOCKED");

    releaseWinner();
    await run1;
    await expect(stat(lockPath())).rejects.toThrow();
    await expect(stat(guardDir)).rejects.toThrow();
  });

  it("does not let a slow recovery contender delete a replacement owner's guard", async () => {
    const guardDir = lockPath() + ".guard";
    await mkdir(join(dir, "kestrel"), { recursive: true });
    await mkdir(guardDir);
    await writeFile(
      join(guardDir, "owner.json"),
      JSON.stringify({
        schemaVersion: 1,
        pid: 99999999,
        createdAt: "2026-08-15T10:00:00Z",
        token: "dead-token",
      }),
      "utf8",
    );

    let reached = false;
    let resume: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const slow = new FileMissionLock({
      onDeadGuardOwner: async (path, deadToken) => {
        expect(path).toBe(guardDir);
        expect(deadToken).toBe("dead-token");
        reached = true;
        await gate;
      },
    });

    const slowBreak = slow.breakStaleLock(lockPath());
    await waitFor(() => reached);

    // A fresh owner takes over the guard while the slow contender is paused.
    let replacementHeld = false;
    let releaseReplacement: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });
    const replacement = new FileMissionLock();
    const replacementRun = replacement.withMissionLock(
      lockPath(),
      missionId,
      "complete",
      async () => {
        replacementHeld = true;
        await hold;
      },
    );
    await waitFor(() => replacementHeld);

    // The slow contender resumes and must be excluded; the replacement guard
    // and lock survive untouched.
    resume();
    await expectCode(slowBreak, "DM_MISSION_LOCKED");

    const raw = JSON.parse(await readFile(lockPath(), "utf8")) as { pid: number };
    expect(raw.pid).toBe(process.pid);
    expect(await readdir(guardDir)).toHaveLength(1);

    releaseReplacement();
    await replacementRun;
    await expect(stat(lockPath())).rejects.toThrow();
  });

  it("does not mistake a paused in-progress acquisition for abandoned residue", async () => {
    let reserved = false;
    let resume: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const lock = new FileMissionLock({
      onGuardReserved: async () => {
        reserved = true;
        await gate;
      },
    });

    const acquisition = lock.withMissionLock(
      lockPath(),
      missionId,
      "complete",
      async () => undefined,
    );
    await waitFor(() => reserved);

    // The reservation is not yet committed: the guard path itself is absent, so
    // a recovery attempt can neither mistake it for residue nor corrupt it.
    await expect(stat(lockPath() + ".guard")).rejects.toThrow();

    const recovery = new FileMissionLock();
    await recovery.breakStaleLock(lockPath());

    resume();
    await acquisition;

    // The paused acquisition completed normally; no residue remains.
    await expect(stat(lockPath())).rejects.toThrow();
    await expect(stat(lockPath() + ".guard")).rejects.toThrow();
    expect(await readdir(join(dir, "kestrel"))).toHaveLength(0);
  });
});
