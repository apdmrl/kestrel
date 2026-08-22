import { readFileSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

/** POSIX-only shell binaries (used as executables) that must never be invoked. */
const BANNED_BINARY_PATTERNS: Array<{ label: string; re: RegExp }> = [
  // mkfifo invoked as an executable.
  { label: "mkfifo", re: /\bmkfifo\b/ },
  // The POSIX `timeout` binary invoked as `timeout <seconds> <command>`, as
  // opposed to the Node child_process `timeout:` option.
  { label: "timeout", re: /\btimeout\s+\d/ },
];
/** Bash-only idioms that make a script non-portable on Windows. */
const BANNED_BASH = ["bash", "/usr/bin/git", "printf x >"];

async function listFiles(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      files.push(...(await listFiles(full)));
    } else if (stat.isFile()) {
      files.push(full);
    }
  }
  return files;
}

describe("cross-platform release gate", () => {
  it("cleans the build output with a portable Node script, not a POSIX rm -rf", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.build).toBeDefined();
    // The build must not shell out to `rm -rf`, which fails on Windows runners.
    expect(pkg.scripts.build).not.toMatch(/rm\s+-rf/);
    // It must delegate cleanup to a checked-in Node script (fs.rm is portable).
    expect(pkg.scripts.build).toMatch(/node scripts\//);
    const cleanPath = /node\s+(scripts\/[\w./-]+)/.exec(pkg.scripts.build)?.[1];
    expect(cleanPath).toBeTruthy();
    const clean = readFileSync(join(root, cleanPath as string), "utf8");
    expect(clean).toContain("fs.rm");
  });

  it("never invokes POSIX-only shell tools from common E2E or package helpers", async () => {
    const targets = [
      "test/e2e",
      "test/package",
      "scripts",
      "src/infrastructure/transactions",
      "src/application/transactions",
    ];
    const files = (await Promise.all(targets.map((dir) => listFiles(join(root, dir))))).flat();
    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith(".test.ts") && file.includes("portability")) {
        continue;
      }
      const content = await readFile(file, "utf8");
      for (const { label, re } of BANNED_BINARY_PATTERNS) {
        if (re.test(content)) {
          offenders.push(`${file}: references banned binary \`${label}\``);
        }
      }
      for (const banned of BANNED_BASH) {
        if (content.includes(banned)) {
          offenders.push(`${file}: references bash-only idiom \`${banned}\``);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("resolves the installed binary across Windows (.cmd), macOS, and Linux", () => {
    // The packaged-bin test and smoke script must select a platform-specific
    // shim name so the installed executable is found on every OS family.
    const packageTest = readFileSync(join(root, "test/package/package.test.ts"), "utf8");
    const smoke = readFileSync(join(root, "scripts/package-smoke.mjs"), "utf8");
    for (const source of [packageTest, smoke]) {
      expect(source).toContain("process.platform");
      expect(source).toMatch(/\.cmd|win32/);
    }
  });

  it("composes PATH with the platform delimiter in common E2E helpers", async () => {
    // On Windows PATH entries are separated by `;`, on POSIX by `:`. A hard-coded
    // `":"` concatenation silently prevents the fake/no-credential Git shim from
    // being selected on Windows runners, so the common E2E gate must always use
    // `node:path`'s platform delimiter (`delim`).
    const files = (
      await Promise.all(["test/e2e", "test/package"].map((dir) => listFiles(join(root, dir))))
    ).flat();
    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith(".test.ts") && file.includes("portability")) {
        continue;
      }
      const content = await readFile(file, "utf8");
      if (/\+ *":" *\+/.test(content)) {
        offenders.push(`${file}: composes PATH with a hard-coded ":"`);
      }
      if (/\+ *";" *\+/.test(content)) {
        offenders.push(`${file}: composes PATH with a hard-coded ";"`);
      }
      if (/[.:]+ *\+ *"?PATH"?/.test(content) && content.includes("process.env.PATH")) {
        // Any bare `dir + <literal> + process.env.PATH` is a portability hazard.
        offenders.push(`${file}: concatenates a PATH entry with a literal separator`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the CI matrix running on all three OS families under Node 24", () => {
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain("ubuntu-latest");
    expect(ci).toContain("macos-latest");
    expect(ci).toContain("windows-latest");
    expect(ci).toContain("node-version: 24");
  });
});
