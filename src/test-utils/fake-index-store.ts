import type {
  MissionIndex,
  MissionIndexEntry,
  MissionIndexStore,
} from "../ports/mission-index-store.js";

/** In-memory Mission index for application and transaction tests. */
export class FakeIndexStore implements MissionIndexStore {
  readonly entries: MissionIndexEntry[] = [];

  async get(): Promise<{ index: MissionIndex; version: number }> {
    return { index: { entries: [...this.entries] }, version: this.entries.length };
  }

  async save(
    index: MissionIndex,
    expectedVersion: number,
  ): Promise<{ index: MissionIndex; version: number }> {
    this.entries.splice(0, this.entries.length, ...index.entries);
    return { index, version: expectedVersion + 1 };
  }
}
