import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cache = join(root, "..", ".npm-cache");
const env = { ...process.env, npm_config_cache: cache };

const packOut = spawnSync("npm", ["pack", "--json"], { cwd: root, encoding: "utf8", env });
if (packOut.status !== 0) {
  console.error(packOut.stderr);
  process.exit(packOut.status ?? 1);
}
const tarball = JSON.parse(packOut.stdout)[0].filename;

const prefix = mkdtempSync(join(tmpdir(), "kestrel-pkg-"));
try {
  const install = spawnSync(
    "npm",
    ["install", "--prefix", prefix, join(root, tarball), "--ignore-scripts"],
    { cwd: root, stdio: "inherit", env },
  );
  if (install.status !== 0) {
    process.exit(install.status ?? 1);
  }
  const bin = join(
    prefix,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "kestrel.cmd" : "kestrel",
  );
  const run = (args) => {
    const options = { encoding: "utf8" };
    return process.platform === "win32"
      ? spawnSync("cmd.exe", ["/c", bin, ...args], options)
      : spawnSync(bin, args, options);
  };
  const version = run(["--version"]);
  if (version.status !== 0) {
    throw new Error("--version failed: " + String(version.stderr));
  }
  const versionText = String(version.stdout).trim();
  console.log("smoke version: " + versionText);
  if (versionText !== "0.1.0") {
    throw new Error("unexpected version: " + versionText);
  }
} finally {
  rmSync(prefix, { recursive: true, force: true });
  rmSync(join(root, tarball), { force: true });
}
console.log("package smoke test passed");
