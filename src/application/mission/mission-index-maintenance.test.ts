import { describe, expect, it } from "vitest";
import { createKestrelError } from "../errors/kestrel-error.js";
import type { MissionId } from "../../domain/shared/identifiers.js";
import type { IsoDateTime } from "../../domain/shared/time.js";
import type {
  MissionIndex,
  MissionIndexEntry,
  MissionIndexStore,
} from "../../ports/mission-index-store.js";
import { upsertMissionIndex } from "./mission-index-maintenance.js";

const now = "2026-08-15T10:00:00Z" as IsoDateTime;

function entry(missionId: string): MissionIndexEntry {
  return {
    missionId: missionId as MissionId,
    sidecarPath: "/tmp/" + missionId + "/kestrel",
    repository: { provider: "github", owner: "octocat", name: "hello-world" },
    status: "ACCEPTED",
    updatedAt: now,
  };
}

function conflict() {
  return createKestrelError({
    code: "DM_STORE_CONFLICT",
    category: "CONFLICT",
    userMessage: "index changed",
    suggestedActions: ["retry"],
    retryability: "NO_RETRY",
    recoveryStrategy: "USER_ACTION",
    severity: "ERROR",
  });
}

class ControlledStore implements MissionIndexStore {
  private version = 0;
  private entries: MissionIndexEntry[] = [];
  onGet?: () => Promise<void>;
  failNextSaves = 0;

  async get(): Promise<{ index: MissionIndex; version: number }> {
    if (this.onGet !== undefined) {
      await this.onGet();
    }
    return { index: { entries: [...this.entries] }, version: this.version };
  }

  async save(
    index: MissionIndex,
    expectedVersion: number,
  ): Promise<{ index: MissionIndex; version: number }> {
    if (this.failNextSaves > 0) {
      this.failNextSaves -= 1;
      throw conflict();
    }
    if (expectedVersion !== this.version) {
      throw conflict();
    }
    this.entries = [...index.entries];
    this.version = expectedVersion + 1;
    return { index, version: this.version };
  }
}

describe("upsertMissionIndex", () => {
  it("converges when two writers observe the same initial version", async () => {
    const store = new ControlledStore();
    let getCount = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    store.onGet = async () => {
      getCount += 1;
      if (getCount === 2) {
        release();
      }
      await gate;
    };

    await Promise.all([
      upsertMissionIndex(store, entry("m1")),
      upsertMissionIndex(store, entry("m2")),
    ]);

    const { index, version } = await store.get();
    expect(index.entries.map((e) => e.missionId).sort()).toEqual(["m1", "m2"]);
    expect(version).toBe(2);
  });

  it("retries a conflicting save without dropping the entry", async () => {
    const store = new ControlledStore();
    store.failNextSaves = 1;
    await upsertMissionIndex(store, entry("m1"));
    const { index, version } = await store.get();
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0]?.missionId).toBe("m1");
    expect(version).toBe(1);
  });

  it("is a no-op when the entry is already current", async () => {
    const store = new ControlledStore();
    await upsertMissionIndex(store, entry("m1"));
    await upsertMissionIndex(store, entry("m1"));
    const { index, version } = await store.get();
    expect(index.entries).toHaveLength(1);
    expect(version).toBe(1);
  });
});
