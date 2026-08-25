import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const distMain = join(root, "dist", "cli", "main.js");

/** Run npm. On Windows `npm` is `npm.cmd` and needs the command interpreter. */
async function runNpm(args: string[]): Promise<void> {
  await (process.platform === "win32"
    ? execFileAsync("cmd.exe", ["/c", "npm", ...args], { cwd: root, timeout: 120_000 })
    : execFileAsync("npm", args, { cwd: root, timeout: 120_000 }));
}

function runCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [distMain, ...args],
      {
        env: { ...process.env, ...env },
        cwd: root,
        timeout: 30_000,
      },
      (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== "number") {
          reject(error);
          return;
        }
        const code = error === null ? 0 : (error.code as number);
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

describe("built CLI", () => {
  beforeAll(async () => {
    await runNpm(["run", "build"]);
  }, 120_000);

  it("exposes the complete v0.1 command hierarchy", async () => {
    for (const [group, expected] of [
      ["", ["find", "mission", "agent", "verify", "journey", "progress", "preferences"]],
      ["mission", ["accept", "prepare", "resume", "current", "complete", "break-lock", "abandon"]],
      ["agent", ["brief"]],
      ["verify", ["submission", "link", "merge"]],
    ] as const) {
      const result = await runCli(group === "" ? ["--help"] : [group, "--help"]);
      expect(result.code).toBe(0);
      for (const name of expected) {
        expect(result.stdout).toContain(name);
      }
    }
  }, 60_000);

  it("runs progress with a zero exit code against a temp home", async () => {
    const home = mkdtempSync(join(tmpdir(), "kestrel-cli-"));
    try {
      const result = await runCli(["progress"], { KESTREL_HOME: home });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Accepted: 0");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  it("routes preferences get with a zero exit code", async () => {
    const home = mkdtempSync(join(tmpdir(), "kestrel-cli-"));
    try {
      const result = await runCli(["preferences", "get"], { KESTREL_HOME: home });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("GUIDED");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  it("reports find auth errors to stderr with a nonzero exit code", async () => {
    const home = mkdtempSync(join(tmpdir(), "kestrel-cli-"));
    try {
      const result = await runCli(["find"], {
        KESTREL_HOME: home,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: join(home, "empty-gitconfig"),
        GIT_TERMINAL_PROMPT: "0",
      });
      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Error");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  it("keeps argument-bearing progress on the one-shot path", async () => {
    const home = mkdtempSync(join(tmpdir(), "kestrel-cli-one-shot-"));
    try {
      const result = await runCli(["--no-interactive", "progress"], { KESTREL_HOME: home });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Accepted: 0");
      expect(result.stdout).not.toContain("kestrel ›");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
