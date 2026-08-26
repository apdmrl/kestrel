import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = process.cwd();
const cli = join(root, "dist", "cli", "main.js");

let home: string;
let shimDir: string;

interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
}

/**
 * Fake `git` exposing a configured credential helper that holds no credential.
 * A real helper is required for "not connected" to be distinguishable from
 * "no credential helper configured", which is a different, classified error.
 */
async function createCredentialShim(dir: string, token: string | undefined): Promise<void> {
  const script = [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'credential' && args[1] === 'fill') {",
    token === undefined
      ? "  // helper configured, but no credential stored"
      : `  process.stdout.write('username=octocat\\npassword=${token}\\n');`,
    "  process.exit(0);",
    "}",
    "if (args[0] === 'config' && args[1] === '--get' && args[2] === 'credential.helper') {",
    "  process.stdout.write('fake-helper\\n');",
    "  process.exit(0);",
    "}",
    "if (args[0] === 'credential') { process.exit(0); }",
    "process.exit(0);",
    "",
  ].join("\n");
  await writeFile(join(dir, "git"), script, "utf8");
  // Windows resolves a bare `git` to `git.cmd` through PATHEXT.
  await writeFile(join(dir, "git.cmd"), '@echo off\r\nnode "%~dp0git" %*\r\n', "utf8");
  await chmod(join(dir, "git"), 0o755);
}

function run(args: string[], env: Record<string, string> = {}): CliResult {
  const result = spawnSync("node", [cli, ...args], {
    cwd: root,
    env: {
      ...process.env,
      KESTREL_HOME: home,
      PATH: shimDir + delimiter + (process.env.PATH ?? ""),
      ...env,
    },
    encoding: "utf8",
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

/**
 * Non-blocking CLI run, required whenever the test also serves HTTP from this
 * process: spawnSync would block the event loop and deadlock the request.
 */
function runAsync(argv: string[], env: Record<string, string>): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", argv, {
      cwd: root,
      env: { ...process.env, KESTREL_HOME: home, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (status: number | null) => resolve({ stdout, stderr, status }));
  });
}

beforeAll(async () => {
  const build =
    process.platform === "win32"
      ? spawnSync("cmd.exe", ["/c", "npm", "run", "build"], { cwd: root })
      : spawnSync("npm", ["run", "build"], { cwd: root });
  if (build.status !== 0) {
    throw new Error("npm run build failed:\n" + (build.stderr?.toString() ?? ""));
  }
  home = await mkdtemp(join(tmpdir(), "kestrel-auth-e2e-"));
  shimDir = await mkdtemp(join(tmpdir(), "kestrel-auth-shim-"));
  await createCredentialShim(shimDir, undefined);
}, 180_000);

afterAll(async () => {
  for (const dir of [home, shimDir]) {
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("built CLI auth commands", () => {
  it("documents the auth command group", () => {
    const result = run(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("auth");
    expect(result.stdout).toContain("--no-browser");
  });

  it("documents the auth subcommands", () => {
    const result = run(["auth", "--help"]);
    expect(result.status).toBe(0);
    for (const name of ["login", "status", "logout"]) {
      expect(result.stdout).toContain(name);
    }
  });

  it("reports not connected as a single json document with a zero exit", () => {
    const result = run(["--json", "auth", "status"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      data: { kind: string; connected: boolean; login: string | null; detail: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toEqual({
      kind: "auth-status",
      connected: false,
      login: null,
      detail: "NOT_CONNECTED",
    });
  });

  it("reports not connected in plain mode", () => {
    const result = run(["auth", "status"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Not connected");
    expect(result.stdout).toContain("kestrel auth login");
  });

  it("refuses logout without a confirmation and exits 2", () => {
    const result = run(["auth", "logout"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("github.com");
  });

  it("refuses logout with a wrong confirmation and exits 2", () => {
    const result = run(["auth", "logout", "--confirm", "yes"]);
    expect(result.status).toBe(2);
  });

  it("clears the credential when confirmed", () => {
    const result = run(["auth", "logout", "--confirm", "github.com"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Logged out");
  });

  it("accepts --no-browser without changing the status contract", () => {
    const result = run(["--no-browser", "--json", "auth", "status"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean };
    expect(parsed.ok).toBe(true);
  });

  it("fails login without a client id and never leaks the token or device code", () => {
    const result = run(["--no-interactive", "auth", "login"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Error");
    expect(result.stderr).not.toContain("login/device");
  });

  it("reports an expired credential without ever printing the token", async () => {
    const connectedShim = await mkdtemp(join(tmpdir(), "kestrel-auth-connected-"));
    // A local server that rejects the token, so the expiry path is exercised
    // deterministically instead of relying on network timeouts.
    const server = createServer((_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "Bad credentials" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      await createCredentialShim(connectedShim, "SECRET_TOKEN_XYZ");
      // spawnSync would deadlock: it blocks this event loop, so the in-process
      // server could never accept the child's connection.
      const result = await runAsync([cli, "--json", "auth", "status"], {
        PATH: connectedShim + delimiter + (process.env.PATH ?? ""),
        GITHUB_API_URL: "http://127.0.0.1:" + String(port),
      });
      expect(result.stdout + result.stderr).not.toContain("SECRET_TOKEN_XYZ");
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout) as { data: { detail: string; login: null } };
      expect(parsed.data.detail).toBe("EXPIRED");
      expect(parsed.data.login).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(connectedShim, { recursive: true, force: true });
    }
  }, 30_000);
});
