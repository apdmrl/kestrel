import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = process.cwd();
const cache = join(root, "..", ".npm-cache");
const env = { ...process.env, npm_config_cache: cache };
let tarball = "";
let prefix = "";

/**
 * Resolve the installed executable. npm publishes a shell shim and, on Windows,
 * a `kestrel.cmd` shim into `node_modules/.bin`. The `.cmd` shim must be
 * launched through the Windows command interpreter.
 */
function installedBin(): string {
  return join(
    prefix,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "kestrel.cmd" : "kestrel",
  );
}

function runInstalled(
  args: string[],
  spawnEnv: NodeJS.ProcessEnv,
): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const bin = installedBin();
  const options = { env: spawnEnv, encoding: "utf8" as const };
  const result =
    process.platform === "win32"
      ? spawnSync("cmd.exe", ["/c", bin, ...args], options)
      : spawnSync(bin, args, options);
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

beforeAll(() => {
  const pack = spawnSync("npm", ["pack", "--json"], { cwd: root, encoding: "utf8", env });
  tarball = (JSON.parse(pack.stdout) as Array<{ filename: string }>)[0]?.filename ?? "";
  prefix = mkdtempSync(join(tmpdir(), "kestrel-pkg-"));
  const install = spawnSync(
    "npm",
    ["install", "--prefix", prefix, join(root, tarball), "--ignore-scripts"],
    { cwd: root, stdio: "ignore", env },
  );
  if (install.status !== 0) {
    throw new Error("npm install of the tarball failed");
  }
}, 60_000);

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
    const result = runInstalled(["--version"], { ...process.env });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("0.1.0");
  });

  it("runs --help from a clean install", () => {
    const result = runInstalled(["--help"], { ...process.env });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("kestrel");
  });

  it("runs an empty journey from a clean install", () => {
    const result = runInstalled(["--json", "journey"], {
      ...process.env,
      KESTREL_HOME: join(prefix, "home"),
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean };
    expect(parsed.ok).toBe(true);
  });
});
