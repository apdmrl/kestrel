import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = process.cwd();
const cli = join(root, "dist", "cli", "main.js");

let home: string;

interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
}

function run(args: string[]): CliResult {
  const result = spawnSync("node", [cli, ...args], {
    cwd: root,
    env: { ...process.env, KESTREL_HOME: home },
    encoding: "utf8",
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

beforeAll(() => {
  // On Windows `npm` is `npm.cmd` and requires the command interpreter.
  const build =
    process.platform === "win32"
      ? spawnSync("cmd.exe", ["/c", "npm", "run", "build"], { cwd: root })
      : spawnSync("npm", ["run", "build"], { cwd: root });
  if (build.status !== 0) {
    throw new Error("npm run build failed:\n" + (build.stderr?.toString() ?? ""));
  }
});

afterAll(async () => {
  if (home !== undefined) {
    await rm(home, { recursive: true, force: true });
  }
});

describe("kestrel CLI", () => {
  it("prints help and version", async () => {
    home = await mkdtemp(join(tmpdir(), "kestrel-e2e-"));
    expect(run(["--help"]).stdout).toContain("kestrel");
    expect(run(["--version"]).stdout.trim()).toBe("0.1.0");
  });

  it("prints an empty journey as JSON without credentials", async () => {
    home = await mkdtemp(join(tmpdir(), "kestrel-e2e-"));
    const result = run(["--json", "journey"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      data: { kind: string; entries: unknown[] };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.kind).toBe("journey");
    expect(parsed.data.entries).toEqual([]);
  });

  it("prints zero progress counts as JSON without credentials", async () => {
    home = await mkdtemp(join(tmpdir(), "kestrel-e2e-"));
    const result = run(["--json", "progress"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      data: { kind: string; counts: { accepted: number } };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.kind).toBe("progress");
    expect(parsed.data.counts.accepted).toBe(0);
  });

  it("classifies a corrupt journey line without leaking or crashing", async () => {
    home = await mkdtemp(join(tmpdir(), "kestrel-e2e-"));
    await mkdir(join(home, "journey"), { recursive: true });
    await writeFile(join(home, "journey", "events.jsonl"), "{ not json", "utf8");
    const result = run(["--json", "journey"]);
    expect(result.status).not.toBe(0);
    const parsed = JSON.parse(result.stderr) as { ok: boolean; error: { code: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("DM_STATE_CORRUPTED");
  });
});
