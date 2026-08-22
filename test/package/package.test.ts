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
let packedFiles: string[] = [];

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

/**
 * Run npm as a child process. On Windows `npm` resolves to `npm.cmd`, which
 * Node's spawn cannot execute directly (ENOENT) and must be launched through
 * the Windows command interpreter.
 */
function runNpm(
  args: string[],
  options: { cwd?: string; encoding?: "utf8"; stdio?: "pipe" | "ignore"; env?: NodeJS.ProcessEnv },
): { status: number | null; stdout: string; stderr: string; error?: Error } {
  const spawnArgs = process.platform === "win32" ? ["/c", "npm", ...args] : args;
  const result =
    process.platform === "win32"
      ? spawnSync("cmd.exe", spawnArgs, { ...options, encoding: "utf8" })
      : spawnSync("npm", spawnArgs, { ...options, encoding: "utf8" });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
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
  const pack = runNpm(["pack", "--json"], { cwd: root, encoding: "utf8", env });
  const parsed = JSON.parse(pack.stdout) as Array<{
    filename: string;
    files: Array<{ path: string }>;
  }>;
  const first = parsed[0];
  tarball = first?.filename ?? "";
  packedFiles = (first?.files ?? []).map((f) => f.path);
  prefix = mkdtempSync(join(tmpdir(), "kestrel-pkg-"));
  const install = runNpm(["install", "--prefix", prefix, join(root, tarball), "--ignore-scripts"], {
    cwd: root,
    stdio: "ignore",
    env,
  });
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
  // The first `cmd.exe /c kestrel.cmd` spawn on Windows is a cold start
  // (shell setup + first node boot) that can exceed Vitest's default 5s
  // timeout; give the spawned-CLI tests explicit headroom.
  const CLI_TIMEOUT_MS = 30_000;

  it("runs --version from a clean install", { timeout: CLI_TIMEOUT_MS }, () => {
    const result = runInstalled(["--version"], { ...process.env });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("0.1.0");
  });

  it("runs --help from a clean install", { timeout: CLI_TIMEOUT_MS }, () => {
    const result = runInstalled(["--help"], { ...process.env });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("kestrel");
  });

  it("runs an empty journey from a clean install", { timeout: CLI_TIMEOUT_MS }, () => {
    const result = runInstalled(["--json", "journey"], {
      ...process.env,
      KESTREL_HOME: join(prefix, "home"),
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean };
    expect(parsed.ok).toBe(true);
  });

  it("ships a complete, clean package artifact", () => {
    const names = packedFiles.map((p) => p.split("/").pop() ?? p);
    // The package contract requires metadata, dist, README, CHANGELOG, and a
    // LICENSE in the tarball.
    expect(packedFiles.some((p) => p.startsWith("dist/"))).toBe(true);
    expect(names).toContain("README.md");
    expect(names).toContain("CHANGELOG.md");
    expect(names).toContain("LICENSE");
    expect(packedFiles.some((p) => p === "package.json")).toBe(true);
    // Forbidden content must be absent: source fixtures, user state, tokens,
    // progress files, and generated tarballs.
    const forbidden = [
      ".env",
      "index.json",
      "preferences.json",
      "events.jsonl",
      "IMPLEMENTATION_PROGRESS.md",
      ".tgz",
      "mission.json",
    ];
    for (const needle of forbidden) {
      expect(packedFiles.some((p) => p.endsWith(needle))).toBe(false);
    }
    expect(packedFiles.some((p) => p.startsWith("src/") || p.startsWith("test/"))).toBe(false);
  });
});
