import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExecaProcessRunner } from "./execa-process-runner.js";

/**
 * POSIX-only integration evidence for PROCESS-TREE-004: a real
 * `git credential fill` lookup with a configured hanging helper
 * descendant must be torn down with the parent when the AbortSignal
 * fires. The fixture deliberately does NOT swap `git` for a shim
 * (the second review required real-Git evidence) and does NOT
 * substitute a fake process group. On non-POSIX platforms the suite
 * is reported as skipped so the Windows shell behavior stays
 * explicit and unaffected.
 */

const isPosix = process.platform !== "win32";

function pidAlive(pid: number): boolean {
  if (!isPosix) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

async function waitForFile(path: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`timeout waiting for ${path}`);
}

async function makeTempFile(parent: string, subpath: string): Promise<void> {
  const absolute = join(parent, subpath);
  const slash = absolute.lastIndexOf("/");
  if (slash >= 0) {
    await mkdir(absolute.slice(0, slash), { recursive: true });
  }
  await writeFile(absolute, "", "utf8");
}

async function runRealGitCapturing(cwd: string, args: readonly string[]): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const chunks: Buffer[] = [];
  const child = spawn("git", [...args], { cwd });
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.on("error", reject);
  child.on("exit", (code) => {
    if (code === 0) {
      resolve(Buffer.concat(chunks).toString("utf8"));
    } else {
      reject(new Error(`git ${args.join(" ")} exited ${code ?? "null"}`));
    }
  });
  return promise;
}

async function runRealGit(cwd: string, args: readonly string[]): Promise<void> {
  await runRealGitCapturing(cwd, args);
}

describe.skipIf(!isPosix)(
  "ExecaProcessRunner — real git with a configured credential helper",
  () => {
    let dir = "";
    let previousPath: string | undefined;
    const helperPids: number[] = [];

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "kestrel-helper-"));
      previousPath = process.env.PATH;
    });

    afterEach(async () => {
      for (const pid of helperPids) {
        if (pidAlive(pid)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // already gone
          }
        }
      }
      helperPids.length = 0;
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
      if (dir !== "") {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it(
      "aborts the direct git child and the hanging helper descendant in the same process group",
      async () => {
        const repoDir = join(dir, "repo");
        await makeTempFile(repoDir, ".gitkeep");
        await runRealGit(repoDir, ["init", "--quiet"]);
        await runRealGit(repoDir, ["config", "user.email", "test@example.com"]);
        await runRealGit(repoDir, ["config", "user.name", "Test"]);

        const helperPath = join(dir, "hang-helper.sh");
        const helperPidFile = join(dir, "helper.pid");
        const helperScript = [
          "#!/usr/bin/env bash",
          `echo $$ > "${helperPidFile}"`,
          "while true; do sleep 1; done",
          "",
        ].join("\n");
        await writeFile(helperPath, helperScript, "utf8");
        await chmod(helperPath, 0o755);
        await runRealGit(repoDir, [
          "config",
          "--add",
          "credential.helper",
          helperPath,
        ]);

        const runner = new ExecaProcessRunner();
        const controller = new AbortController();

        const pending = runner.run({
          executable: "git",
          args: ["credential", "fill"],
          cwd: repoDir,
          signal: controller.signal,
          timeoutMs: 30_000,
          input: "protocol=https\nhost=example.test\n",
        });

        // The helper writes its own PID before sleeping. Wait for it.
        const pidText = await waitForFile(helperPidFile, 5_000);
        const helperPid = Number.parseInt(pidText.trim(), 10);
        expect(Number.isFinite(helperPid)).toBe(true);
        expect(helperPid).toBeGreaterThan(0);
        helperPids.push(helperPid);
        // The helper is alive before the abort fires.
        expect(pidAlive(helperPid)).toBe(true);

        controller.abort();

        await expect(pending).rejects.toMatchObject({
          code: "DM_PROCESS_CANCELLED",
        });

        // The hanging helper descendant must also be gone — proof
        // that the runner's POSIX process-group kill reached Git's
        // spawned helper (PROCESS-TREE-004).
        expect(pidAlive(helperPid)).toBe(false);
      },
      35_000,
    );

    it(
      "writes the configured helper script and reads it back from the repo",
      async () => {
        const repoDir = join(dir, "smoke");
        await makeTempFile(repoDir, ".gitkeep");
        await runRealGit(repoDir, ["init", "--quiet"]);
        const helperPath = join(dir, "noop-helper.sh");
        await writeFile(helperPath, "#!/usr/bin/env bash\nexit 0\n", "utf8");
        await chmod(helperPath, 0o755);
        await runRealGit(repoDir, [
          "config",
          "--add",
          "credential.helper",
          helperPath,
        ]);
        const out = await runRealGitCapturing(repoDir, ["config", "credential.helper"]);
        expect(out.trim()).toBe(helperPath);
      },
    );
  },
);