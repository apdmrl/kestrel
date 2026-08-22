import { readFileSync } from "node:fs";

const logPath = process.argv[2];
if (!logPath) {
  process.exit(0);
}

let lines;
try {
  lines = readFileSync(logPath, "utf8").split("\n");
} catch {
  process.exit(0);
}

const CRASH_MARKERS = [
  /\[kestrel-ci\]/,
  /uncaughtException/,
  /unhandledRejection/,
  /UnhandledRejection/,
  /uncaughtExceptionMonitor/,
  /--trace-uncaught/,
  /node:internal\//,
  /Segmentation fault/i,
  /heap out of memory/i,
  /JavaScript heap out of memory/i,
  /Reached heap limit/i,
  /Worker terminated/i,
  /Failed to load worker/i,
  /ECONNRESET/i,
];

const crashLines = [];
lines.forEach((line, i) => {
  if (CRASH_MARKERS.some((re) => re.test(line))) {
    crashLines.push(i + 1);
  }
});

function emitError(title, body) {
  const cleaned = body
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l !== "");
  if (cleaned.length === 0) return;
  for (const line of cleaned) {
    process.stdout.write(`::error title=${title}::${escapeData(line)}\n`);
  }
}

function escapeData(s) {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/:/g, "%3A");
}

if (crashLines.length > 0) {
  // Emit each unique crash-adjacent line exactly once, walking the windows of
  // every marker in ascending order.
  const emitted = new Set();
  let emitCount = 0;
  for (const lineNo of crashLines) {
    const start = Math.max(0, lineNo - 3);
    const end = Math.min(lines.length, lineNo + 12);
    for (let i = start; i < end; i++) {
      if (emitted.has(i)) continue;
      emitted.add(i);
      process.stdout.write(`::error title=crash::${escapeData(lines[i])}\n`);
      emitCount++;
      if (emitCount >= 200) break;
    }
    if (emitCount >= 200) break;
  }
} else {
  // No explicit crash marker: surface the failure tail so the root cause is
  // still visible in the Actions log as an annotation.
  const tail = lines.slice(-60);
  emitError("test-failure-tail", tail.join("\n"));
}
