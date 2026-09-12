import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";

const root = process.cwd();
const execFileAsync = promisify(execFile);
const distMain = join(root, "dist", "cli", "main.js");

function environmentWithoutHostGitCredentials(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("GIT_CONFIG_") &&
        !key.startsWith("GIT_CREDENTIAL_") &&
        key !== "GIT_ASKPASS" &&
        key !== "SSH_ASKPASS",
    ),
  );
}

function createNoCredentialGitShim(): string {
  const shimDir = mkdtempSync(join(tmpdir(), "kestrel-cli-auth-shim-"));
  const script = [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'credential' && args[1] === 'fill') process.exit(0);",
    "if (args[0] === 'config' && args[1] === '--get' && args[2] === 'credential.helper') {",
    "  process.stdout.write('test-helper\\n');",
    "  process.exit(0);",
    "}",
    "process.exit(0);",
    "",
  ].join("\n");
  writeFileSync(join(shimDir, "git"), script, "utf8");
  writeFileSync(join(shimDir, "git.cmd"), '@echo off\r\nnode "%~dp0git" %*\r\n', "utf8");
  chmodSync(join(shimDir, "git"), 0o755);
  return shimDir;
}
/** Run npm. On Windows `npm` is `npm.cmd` and needs the command interpreter.
 * A non-zero exit rejects so a broken build fails the suite instead of
 * silently shipping a stale `dist/`. */
async function runNpm(args: string[]): Promise<void> {
  await (process.platform === "win32"
    ? execFileAsync("cmd.exe", ["/c", "npm", ...args], { cwd: root, timeout: 120_000 })
    : execFileAsync("npm", args, { cwd: root, timeout: 120_000 }));
}
function runCli(
  args: string[],
  env: Record<string, string> = {},
  entrypoint: string = distMain,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [entrypoint, ...args],
      {
        env: { ...environmentWithoutHostGitCredentials(), ...env },
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

  it.skipIf(process.platform === "win32")(
    "runs through a symlinked executable path",
    async () => {
      const binDir = mkdtempSync(join(tmpdir(), "kestrel-cli-bin-"));
      const bin = join(binDir, "kestrel");
      try {
        symlinkSync(distMain, bin);
        const result = await runCli(["--version"], { KESTREL_HOME: join(binDir, "home") }, bin);
        expect(result.code).toBe(0);
        expect(result.stdout.trim()).toBe("0.1.0");
      } finally {
        rmSync(binDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
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
    const shimDir = createNoCredentialGitShim();
    try {
      // The packaged CLI must see a configured test helper that has no
      // credential. The launcher also strips inherited Git configuration, so
      // a workstation helper cannot satisfy this lookup.
      const result = await runCli(["find"], {
        KESTREL_HOME: home,
        PATH: shimDir + delimiter + (process.env.PATH ?? ""),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: join(home, "empty-gitconfig"),
        GIT_TERMINAL_PROMPT: "0",
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("DM_GITHUB_AUTH_REQUIRED");
      expect(result.stderr).not.toContain("login/device");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(shimDir, { recursive: true, force: true });
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

  it("releases a hanging credential helper on SIGTERM without ever starting a device flow", async () => {
    // Task 6 regression: when the startup auth check hangs because the
    // user-configured `git credential fill` shim refuses to exit, a
    // SIGTERM to the built CLI must (a) cancel the hung child via the
    // AbortSignal the runner forwards into `git credential fill`,
    // (b) tear the Ink shell down cleanly without ever invoking the
    // device flow, and (c) exit the parent within a bounded budget
    // with the helper's exit marker present — no timeout, no
    // SIGKILL fallback. The local HTTP fixture records every URL the
    // gateway sees; the assertion that `/login/device/code` was never
    // requested pins the "no implicit device flow" contract.
    const home = mkdtempSync(join(tmpdir(), "kestrel-built-hang-"));
    const shimDir = mkdtempSync(join(tmpdir(), "kestrel-built-hang-shim-"));
    const fillMarker = join(home, "fill.arrived");
    const exitMarker = join(home, "fill.exited");
    const helperScript = [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      "const args = process.argv.slice(2);",
      "const fillMarker = process.env.KESTREL_FILL_MARKER;",
      "const exitMarker = process.env.KESTREL_EXIT_MARKER;",
      "function recordExit() {",
      "  if (exitMarker !== undefined) {",
      "    try { fs.writeFileSync(exitMarker, String(Date.now())); } catch { /* noop */ }",
      "  }",
      "}",
      "process.on('SIGTERM', () => { recordExit(); process.exit(143); });",
      "process.on('SIGINT', () => { recordExit(); process.exit(130); });",
      "if (args[0] === 'credential' && args[1] === 'fill') {",
      "  if (fillMarker !== undefined) {",
      "    try { fs.writeFileSync(fillMarker, String(Date.now())); } catch { /* noop */ }",
      "  }",
      "  // Stay alive until the parent (or a signal) cancels us. The",
      "  // CLI's execa-based runner forwards SIGTERM through the abort",
      "  // signal so a hung helper cannot strand the startup auth check.",
      "  setInterval(() => undefined, 60_000);",
      "  return;",
      "}",
      "if (args[0] === 'config' && args[1] === '--get' && args[2] === 'credential.helper') {",
      "  process.stdout.write('hanging-helper\\n');",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'credential') { process.exit(0); }",
      "process.exit(0);",
      "",
    ].join("\n");
    const helperPath = join(shimDir, "git");
    writeFileSync(helperPath, helperScript, "utf8");
    chmodSync(helperPath, 0o755);

    const deviceCodePaths: string[] = [];
    const server = createServer((req, res) => {
      const url = req.url ?? "";
      if (url.startsWith("/login/device/code")) deviceCodePaths.push(url);
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ message: "not found" }));
    });
    const { promise: listening, resolve: resolveListen } = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", () => resolveListen());
    await listening;
    const address = server.address();
    const serverUrl =
      address !== null && typeof address === "object" ? "http://127.0.0.1:" + address.port : "";
    try {
      const child = spawn(process.execPath, [distMain], {
        cwd: root,
        env: {
          ...environmentWithoutHostGitCredentials(),
          KESTREL_HOME: home,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: join(home, "empty-gitconfig"),
          GIT_TERMINAL_PROMPT: "0",
          PATH: shimDir + delimiter + (process.env.PATH ?? ""),
          GITHUB_API_URL: serverUrl,
          KESTREL_FILL_MARKER: fillMarker,
          KESTREL_EXIT_MARKER: exitMarker,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.on("error", (err) => {
        console.error("CHILD ERROR:", err.message);
      });
      // The startup auth check kicks off `git credential fill` from a
      // mount-time useEffect; the helper writes its marker the moment
      // the child process is spawned. Poll for the marker with a
      // bounded deadline so the test fails fast if the helper never
      // receives the request.
      const fillDeadline = Date.now() + 5_000;
      while (!existsSync(fillMarker) && Date.now() < fillDeadline) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(existsSync(fillMarker), "credential fill marker was never written").toBe(true);
      // Send SIGTERM as soon as the helper has been reached. The
      // built CLI must propagate the signal into the hung
      // `git credential fill` subprocess via the AbortSignal the
      // startup auth check forwards, so the helper exits and writes
      // its exit marker before the parent tears down.
      child.kill("SIGTERM");
      // Wait for the CLI child to exit. The budget covers Node startup
      // (~500ms), the credential-fill helper spawn, and Ink's render
      // cycle before its abort handler unmounts the shell. A parent
      // that exceeds the budget without a SIGKILL fallback signals
      // that production leaked the hung helper.
      const exitCode = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), 15_000);
        child.on("exit", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
        child.on("error", () => {
          clearTimeout(timer);
          resolve(null);
        });
      });
      // Graceful bounded exit only — no timeout (null) or SIGKILL
      // fallback. The CLI's own signal handler aborts the
      // AbortController, execa cancels the helper, and Ink's abort
      // listener unmounts the shell — all graceful exits.
      expect(
        exitCode,
        "CLI parent did not exit gracefully within the bounded budget",
      ).not.toBeNull();
      // 0 (clean), 130/143 (signal-induced termination), or 1 (the
      // non-TTY Ink render error after the signal handler tore the
      // session down) all count as "the shell came down".
      expect([0, 1, 130, 143].includes(exitCode as number)).toBe(true);
      // Causal linkage: the abort signal forwarded into
      // `git credential fill` is what tore the hung helper down.
      // Without the AbortSignal wire-through, execa would leak the
      // child and the exit marker would never appear.
      expect(
        existsSync(exitMarker),
        "git credential fill helper exited without writing its marker",
      ).toBe(true);
      // No implicit device flow: the gateway never saw a
      // /login/device/code request during startup or shutdown.
      expect(deviceCodePaths).toEqual([]);
    } finally {
      const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<void>();
      server.close(() => resolveClosed());
      await closed;
    }
  }, 30_000);
});
