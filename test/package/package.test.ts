import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = process.cwd();
const cache = join(root, "..", ".npm-cache");
const env = { ...process.env, npm_config_cache: cache };
let tarball = "";
let prefix = "";

beforeAll(() => {
  const out = execFileSync("npm", ["pack", "--json"], { cwd: root, encoding: "utf8", env });
  tarball = (JSON.parse(out) as Array<{ filename: string }>)[0]?.filename ?? "";
  prefix = mkdtempSync(join(tmpdir(), "kestrel-pkg-"));
  execFileSync("npm", ["install", "--prefix", prefix, join(root, tarball), "--ignore-scripts"], {
    cwd: root,
    stdio: "ignore",
    env,
  });
});

afterAll(() => {
  if (prefix !== "") {
    rmSync(prefix, { recursive: true, force: true });
  }
  if (tarball !== "") {
    rmSync(join(root, tarball), { force: true });
  }
});

describe("packaged kestrel", () => {
  it("runs --version from a clean install", () => {
    const bin = join(prefix, "node_modules", ".bin", "kestrel");
    const version = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
    expect(version).toBe("0.1.0");
  });

  it("runs an empty journey from a clean install", () => {
    const bin = join(prefix, "node_modules", ".bin", "kestrel");
    const result = spawnSync(bin, ["--json", "journey"], {
      env: { ...process.env, KESTREL_HOME: join(prefix, "home") },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean };
    expect(parsed.ok).toBe(true);
  });
});
