import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
});
