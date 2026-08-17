import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { readValidatedJson, writeJsonAtomically } from "./atomic-json-file.js";

const schema = z.object({ value: z.number() });

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kestrel-atomic-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("atomic-json-file", () => {
  it("writes and reads back valid JSON", async () => {
    const path = join(dir, "state.json");
    await writeJsonAtomically(path, { value: 1 }, schema);
    const read = await readValidatedJson(path, schema);
    expect(read).toEqual({ value: 1 });
  });

  it("rejects a schema-invalid value without replacing the primary", async () => {
    const path = join(dir, "state.json");
    await writeJsonAtomically(path, { value: 1 }, schema);
    await expect(writeJsonAtomically(path, { value: "nope" }, schema)).rejects.toThrow();
    const read = await readValidatedJson(path, schema);
    expect(read).toEqual({ value: 1 });
  });

  it("leaves interrupted temp residue alone and still writes", async () => {
    const path = join(dir, "state.json");
    await writeFile(path + ".deadbeef.tmp", "partial", "utf8");
    await writeJsonAtomically(path, { value: 2 }, schema);
    const read = await readValidatedJson(path, schema);
    expect(read).toEqual({ value: 2 });
    const entries = await readdir(dir);
    expect(entries).toContain("state.json.deadbeef.tmp");
  });

  it("backs up corrupt content byte-for-byte and classifies it as corrupt", async () => {
    const path = join(dir, "state.json");
    const corrupt = "{ not valid json \u0000";
    await writeFile(path, corrupt, "utf8");

    let thrownCode: string | undefined;
    try {
      await readValidatedJson(path, schema);
    } catch (error) {
      thrownCode = (error as { code?: string }).code;
    }
    expect(thrownCode).toBe("DM_STATE_CORRUPTED");

    const entries = await readdir(dir);
    const backup = entries.find((entry) => entry.startsWith("state.json.corrupt-"));
    expect(backup).toBeDefined();
    const backedUp = await readFile(join(dir, backup as string), "utf8");
    expect(backedUp).toBe(corrupt);
  });

  it("returns undefined when the file is absent", async () => {
    const path = join(dir, "missing.json");
    await expect(readValidatedJson(path, schema)).resolves.toBeUndefined();
  });

  it("fsyncs the parent directory after the rename", async () => {
    const path = join(dir, "state.json");
    const fsynced: string[] = [];
    await writeJsonAtomically(path, { value: 1 }, schema, {
      fsyncDirectory: async (directoryPath) => {
        fsynced.push(directoryPath);
      },
    });
    expect(fsynced).toEqual([dir]);
    expect(await readValidatedJson(path, schema)).toEqual({ value: 1 });
  });

  it("surfaces a directory fsync failure without corrupting the primary file", async () => {
    const path = join(dir, "state.json");
    await writeJsonAtomically(path, { value: 1 }, schema);
    await expect(
      writeJsonAtomically(path, { value: 2 }, schema, {
        fsyncDirectory: async () => {
          throw new Error("injected fsync failure");
        },
      }),
    ).rejects.toMatchObject({ code: "DM_STATE_WRITE_FAILED" });
    // The rename already committed; the primary file remains valid, not truncated.
    expect(await readValidatedJson(path, schema)).toEqual({ value: 2 });
  });
});
