#!/usr/bin/env node
// Reproducible repeat harness for the exact recovery matrix documented in
// docs/state-and-recovery.md: the seven preparation-checkpoint crashes plus the
// three real transaction-phase crashes. It runs the narrow test selection
// `REPEAT_COUNT` times (default 3), fails fast on the first failing run, and
// preserves every run's output under .recovery-repeat/run-<n>.log.
//
// Usage:
//   node scripts/repeat-recovery.mjs [count]
//   REPEAT_COUNT=5 node scripts/repeat-recovery.mjs
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const countArg = Number(process.env.REPEAT_COUNT ?? process.argv[2] ?? "3");
const repeatCount = Number.isInteger(countArg) && countArg >= 1 ? countArg : 3;

const outDir = join(root, ".recovery-repeat");
mkdirSync(outDir, { recursive: true });

// Narrow selection: exactly the seven-checkpoint matrix and the three-phase
// transaction matrix in test/e2e/workflows.test.ts.
const testFilter = "seven preparation checkpoints|killed at each exact phase";

const summary = [];
for (let i = 1; i <= repeatCount; i++) {
  const logPath = join(outDir, `run-${i}.log`);
  const start = Date.now();
  const result = spawnSync(
    "npx",
    ["vitest", "run", "test/e2e/workflows.test.ts", "-t", testFilter, "--reporter", "basic"],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const elapsedMs = Date.now() - start;
  const ok = result.status === 0;
  writeFileSync(
    logPath,
    `run ${i}/${repeatCount} ${ok ? "PASS" : "FAIL"} (${elapsedMs}ms)\n\n${result.stdout}\n${
      result.stderr
    }\n`,
  );
  summary.push(`${i}: ${ok ? "PASS" : "FAIL"} (${elapsedMs}ms)`);
  if (!ok) {
    console.error("Repeat run " + i + " FAILED; preserving output at " + logPath);
    console.error(result.stderr);
    console.error("Summary:\n" + summary.join("\n"));
    process.exit(1);
  }
}

console.log("Recovery matrix repeated " + repeatCount + "x, all green.");
console.log("Runs:\n" + summary.join("\n"));
console.log("Per-run logs preserved under " + outDir);
