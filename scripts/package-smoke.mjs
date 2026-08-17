import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cache = join(root, "..", ".npm-cache");
const env = { ...process.env, npm_config_cache: cache };

const packOut = execFileSync("npm", ["pack", "--json"], { cwd: root, encoding: "utf8", env });
const tarball = JSON.parse(packOut)[0].filename;

const prefix = mkdtempSync(join(tmpdir(), "kestrel-pkg-"));
try {
  execFileSync("npm", ["install", "--prefix", prefix, join(root, tarball), "--ignore-scripts"], {
    cwd: root,
    stdio: "inherit",
    env,
  });
  const bin = join(prefix, "node_modules", ".bin", "kestrel");
  const version = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
  console.log("smoke version: " + version);
  if (version !== "0.1.0") {
    throw new Error("unexpected version: " + version);
  }
} finally {
  rmSync(prefix, { recursive: true, force: true });
  rmSync(join(root, tarball), { force: true });
}
console.log("package smoke test passed");
