#!/usr/bin/env node
// Cross-platform build cleanup. `rm -rf dist` is not a valid npm script on the
// Windows runner, so deletion goes through Node's portable fs.rm instead.
import { rm } from "node:fs/promises";
import { join } from "node:path";

const target = process.argv[2];
if (target === undefined) {
  console.error("usage: node scripts/clean.mjs <relative-or-absolute-dir>");
  process.exit(2);
}
const path = join(process.cwd(), target);
try {
  await rm(path, { recursive: true, force: true });
} catch (error) {
  console.error("Failed to clean " + path + ": " + String(error));
  process.exit(1);
}
