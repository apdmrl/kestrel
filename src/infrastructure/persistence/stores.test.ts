import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createChallenge } from "../../domain/challenge/challenge.js";
import {
  createRecommendation,
  snapshotRecommendation,
} from "../../domain/recommendation/recommendation.js";
import type { Challenge } from "../../domain/challenge/challenge.js";
import type { ChallengeId } from "../../domain/shared/identifiers.js";
import type { MissionId } from "../../domain/shared/identifiers.js";
import type { IsoDateTime } from "../../domain/shared/time.js";
import type { RecommendationSnapshot } from "../../domain/recommendation/recommendation.js";
import type { WorkspaceInfo } from "../../domain/mission/mission.js";
import { Mission } from "../../domain/mission/mission.js";
import { createExplicitPreferences } from "../../domain/preferences/preferences.js";
import type { MissionStatus } from "../../domain/mission/mission-status.js";
import { FileSystemMissionStore } from "./file-system-mission-store.js";
import { FileSystemPreferencesStore } from "./file-system-preferences-store.js";
import { FileSystemMissionIndexStore } from "./file-system-mission-index-store.js";

const acceptedAt = "2026-08-15T10:00:00Z" as IsoDateTime;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kestrel-store-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeChallenge(): Challenge {
  const result = createChallenge({
    id: "c1" as ChallengeId,
    externalId: "1",
    repository: { provider: "github", owner: "o", name: "n" },
    issueNumber: 1,
    canonicalUrl: "https://github.com/o/n/issues/1",
    title: "Fix crash",
    description: "desc",
    type: "BUG_FIX",
    createdAt: "2026-08-01T00:00:00Z" as IsoDateTime,
    updatedAt: "2026-08-01T00:00:00Z" as IsoDateTime,
  });
  if (!result.ok) {
    throw new Error("expected ok");
  }
  return result.value;
}

function makeRecommendation(challenge: Challenge): RecommendationSnapshot {
  const result = createRecommendation({
    challenge,
    mood: "QUICK_WIN",
    signalResults: [{ name: "interest", value: 0.9, confidence: 0.8, reason: "matches" }],
    confidence: 0.8,
    evaluatedAt: acceptedAt,
  });
  if (!result.ok) {
    throw new Error("expected ok");
  }
  return snapshotRecommendation(result.value);
}

function preparedMission(sidecarPath: string): Mission {
  const workspace: WorkspaceInfo = {
    root: dir,
    missionDirectory: join(dir, "m1"),
    repositoryPath: join(dir, "m1", "repo"),
    sidecarPath,
  };
  const accepted = Mission.accept({
    id: "m1" as MissionId,
    challengeSnapshot: makeChallenge(),
    recommendationSnapshot: makeRecommendation(makeChallenge()),
    mode: "GUIDED",
    acceptedAt,
  });
  const preparing = accepted.ok ? accepted.value.startPreparation() : null;
  const inProgress = preparing?.ok
    ? preparing.value.completePreparation({
        workspace,
        baseCommit: "base-sha",
        branch: "kestrel/1-fix-crash",
      })
    : null;
  if (!inProgress?.ok) {
    throw new Error("expected ok");
  }
  return inProgress.value;
}

async function expectConflict(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
    throw new Error("expected rejection");
  } catch (error) {
    expect((error as { category?: string }).category).toBe("CONFLICT");
  }
}

describe("FileSystemMissionStore", () => {
  it("returns undefined for absent state", async () => {
    const store = new FileSystemMissionStore();
    await expect(store.get(join(dir, "m1", "kestrel"))).resolves.toBeUndefined();
  });

  it("saves and loads a mission with a version", async () => {
    const store = new FileSystemMissionStore();
    const sidecar = join(dir, "m1", "kestrel");
    await mkdir(sidecar, { recursive: true });
    const mission = preparedMission(sidecar);
    const saved = await store.save(sidecar, mission, 0);
    expect(saved.version).toBe(1);

    const loaded = await store.get(sidecar);
    expect(loaded?.version).toBe(1);
    expect(loaded?.mission.status).toBe("IN_PROGRESS");
    expect(loaded?.mission.immutableBaseCommit).toBe("base-sha");
  });

  it("rejects a stale expected version as a conflict", async () => {
    const store = new FileSystemMissionStore();
    const sidecar = join(dir, "m1", "kestrel");
    await mkdir(sidecar, { recursive: true });
    const mission = preparedMission(sidecar);
    await store.save(sidecar, mission, 0);
    await expectConflict(store.save(sidecar, mission, 0));
  });

  it("classifies corrupt state", async () => {
    const sidecar = join(dir, "m1", "kestrel");
    await mkdir(sidecar, { recursive: true });
    await writeFile(join(sidecar, "mission.json"), "{ not json", "utf8");
    const store = new FileSystemMissionStore();
    await expect(store.get(sidecar)).rejects.toMatchObject({ code: "DM_STATE_CORRUPTED" });
  });
});

describe("FileSystemPreferencesStore", () => {
  it("returns undefined for absent preferences", async () => {
    const store = new FileSystemPreferencesStore(join(dir, "preferences.json"));
    await expect(store.get()).resolves.toBeUndefined();
  });

  it("saves and loads preferences", async () => {
    const store = new FileSystemPreferencesStore(join(dir, "preferences.json"));
    const created = createExplicitPreferences({
      preferredLanguages: ["ts"],
      defaultMode: "EXPERT",
    });
    if (!created.ok) {
      throw new Error("expected ok");
    }
    const saved = await store.save(created.value, 0);
    expect(saved.version).toBe(1);
    const loaded = await store.get();
    expect(loaded?.version).toBe(1);
    expect(loaded?.preferences.preferredLanguages).toEqual(["ts"]);
    expect(loaded?.preferences.defaultMode).toBe("EXPERT");
  });

  it("rejects a stale expected version as a conflict", async () => {
    const store = new FileSystemPreferencesStore(join(dir, "preferences.json"));
    const created = createExplicitPreferences({});
    if (!created.ok) {
      throw new Error("expected ok");
    }
    await store.save(created.value, 0);
    await expectConflict(store.save(created.value, 0));
  });
});

describe("FileSystemMissionIndexStore", () => {
  it("returns an empty index for absent state", async () => {
    const store = new FileSystemMissionIndexStore(join(dir, "index.json"));
    const loaded = await store.get();
    expect(loaded.index.entries).toEqual([]);
    expect(loaded.version).toBe(0);
  });

  it("stores and reads index entries", async () => {
    const store = new FileSystemMissionIndexStore(join(dir, "index.json"));
    const entry = {
      missionId: "m1" as MissionId,
      sidecarPath: "/home/dev/m1/kestrel",
      repository: { provider: "github" as const, owner: "o", name: "n" },
      status: "IN_PROGRESS" as MissionStatus,
      updatedAt: acceptedAt,
    };
    const saved = await store.save({ entries: [entry] }, 0);
    expect(saved.version).toBe(1);

    const loaded = await store.get();
    expect(loaded.version).toBe(1);
    expect(loaded.index.entries).toHaveLength(1);
    expect(loaded.index.entries[0]?.missionId).toBe("m1");
    expect(loaded.index.entries[0]?.status).toBe("IN_PROGRESS");
  });

  it("rejects a stale expected version as a conflict", async () => {
    const store = new FileSystemMissionIndexStore(join(dir, "index.json"));
    const index = { entries: [] };
    await store.save(index, 0);
    await expectConflict(store.save(index, 0));
  });
});
