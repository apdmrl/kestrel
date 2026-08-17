import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileSystemMissionIndexStore } from "../../src/infrastructure/persistence/file-system-mission-index-store.js";

const execFileAsync = promisify(execFile);
const root = process.cwd();

let dir = "";

beforeAll(async () => {
  await execFileAsync("npm", ["run", "build"], { cwd: root, encoding: "utf8" });
  dir = await mkdtemp(join(tmpdir(), "kestrel-index-proc-"));
}, 120_000);

afterAll(async () => {
  if (dir !== "") {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("mission index cross-process serialization", () => {
  it("serializes concurrent upserts from separate processes", async () => {
    const indexPath = join(dir, "index.json");
    const lockPath = join(dir, "index.json.lock");

    const storeUrl = pathToFileURL(
      join(root, "dist", "infrastructure", "persistence", "file-system-mission-index-store.js"),
    ).href;
    const lockUrl = pathToFileURL(
      join(root, "dist", "infrastructure", "locking", "file-mission-lock.js"),
    ).href;
    const upsertUrl = pathToFileURL(
      join(root, "dist", "application", "mission", "mission-index-maintenance.js"),
    ).href;

    const script = [
      "import { FileSystemMissionIndexStore } from " + JSON.stringify(storeUrl) + ";",
      "import { FileMissionLock } from " + JSON.stringify(lockUrl) + ";",
      "import { upsertMissionIndex } from " + JSON.stringify(upsertUrl) + ";",
      "const [filePath, lockPath, missionId] = process.argv.slice(2);",
      "const store = new FileSystemMissionIndexStore(filePath, new FileMissionLock(), lockPath);",
      "await upsertMissionIndex(store, {",
      "  missionId,",
      "  sidecarPath: '/tmp/' + missionId + '/kestrel',",
      "  repository: { provider: 'github', owner: 'octocat', name: 'hello-world' },",
      "  status: 'ACCEPTED',",
      "  updatedAt: '2026-08-15T10:00:00Z',",
      "});",
    ].join("\n");
    await writeFile(join(dir, "upsert.mjs"), script, "utf8");

    await Promise.all([
      execFileAsync("node", [join(dir, "upsert.mjs"), indexPath, lockPath, "m1"]),
      execFileAsync("node", [join(dir, "upsert.mjs"), indexPath, lockPath, "m2"]),
    ]);

    const store = new FileSystemMissionIndexStore(indexPath);
    const { index, version } = await store.get();
    expect(index.entries.map((e) => e.missionId).sort()).toEqual(["m1", "m2"]);
    expect(version).toBe(2);
  }, 60_000);
});
