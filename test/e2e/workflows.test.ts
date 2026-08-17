import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const cli = join(root, "dist", "cli", "main.js");

let server: Server;
let serverUrl = "";
let home = "";
let workspace = "";
let fakeGitDir = "";
let fixture = "";

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<CliResult> {
  return execFileAsync("node", [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      KESTREL_HOME: home,
      KESTREL_WORKSPACE: workspace,
      GITHUB_API_URL: serverUrl,
      PATH: fakeGitDir + ":" + process.env.PATH,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(home, "empty-gitconfig"),
      GIT_TERMINAL_PROMPT: "0",
      ...extraEnv,
    },
  }).then(
    ({ stdout, stderr }) => ({ status: 0, stdout: String(stdout), stderr: String(stderr) }),
    (error) => ({
      status: (error as { code?: unknown }).code as number | null,
      stdout: String((error as { stdout?: unknown }).stdout ?? ""),
      stderr: String((error as { stderr?: unknown }).stderr ?? ""),
    }),
  );
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, encoding: "utf8" });
}

async function findRepo(): Promise<string> {
  const entries = await readdir(workspace);
  for (const entry of entries) {
    const children = await readdir(join(workspace, entry)).catch(() => []);
    if (children.includes("repo")) {
      return join(workspace, entry, "repo");
    }
  }
  throw new Error("no cloned repo found in " + workspace);
}

beforeAll(async () => {
  await execFileAsync("npm", ["run", "build"], { cwd: root, encoding: "utf8" });

  home = await mkdtemp(join(tmpdir(), "kestrel-e2e-home-"));
  workspace = await mkdtemp(join(tmpdir(), "kestrel-e2e-ws-"));

  const fixtureDir = await mkdtemp(join(tmpdir(), "kestrel-e2e-fixture-"));
  fixture = join(fixtureDir, "upstream");
  await mkdir(fixture, { recursive: true });
  await runGit(fixture, ["init", "-b", "main"]);
  await runGit(fixture, ["config", "user.email", "test@example.com"]);
  await runGit(fixture, ["config", "user.name", "Test"]);
  await writeFile(join(fixture, "README.md"), "hello\n", "utf8");
  await runGit(fixture, ["add", "."]);
  await runGit(fixture, ["commit", "-m", "initial"]);

  fakeGitDir = await mkdtemp(join(tmpdir(), "kestrel-e2e-git-"));
  await writeFile(
    join(fakeGitDir, "git"),
    [
      "#!/usr/bin/env bash",
      'if [ "$1" = "credential" ] && [ "$2" = "fill" ]; then',
      "  printf 'username=octocat\\npassword=FAKE_TOKEN_XYZ\\n'",
      "  exit 0",
      "fi",
      'if [ "$1" = "config" ] && [ "$2" = "--get" ] && [ "$3" = "credential.helper" ]; then',
      "  printf 'fake-helper\\n'",
      "  exit 0",
      "fi",
      'if [ "$1" = "clone" ]; then',
      '  /usr/bin/git clone -q "' + fixture + '" "$3"',
      '  /usr/bin/git -C "$3" remote set-url origin https://github.com/octocat/hello-world.git',
      "  exit 0",
      "fi",
      'exec /usr/bin/git "$@"',
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(join(fakeGitDir, "git"), 0o755);

  server = createServer((req, res) => {
    const url = req.url ?? "";
    res.setHeader("content-type", "application/json");
    if (url.startsWith("/search/issues")) {
      res.end(
        JSON.stringify({
          items: [
            {
              id: 101,
              number: 42,
              title: "Fix crash on startup",
              body: "The app crashes on startup.",
              state: "open",
              repository_url: "https://api.github.com/repos/octocat/hello-world",
              html_url: "https://github.com/octocat/hello-world/issues/42",
              created_at: "2026-08-01T00:00:00Z",
              updated_at: "2026-08-02T00:00:00Z",
              labels: [{ name: "bug" }],
            },
          ],
        }),
      );
      return;
    }
    if (url.startsWith("/repos/octocat/hello-world")) {
      res.end(JSON.stringify({ archived: false, stargazers_count: 100, open_issues_count: 5 }));
      return;
    }
    if (url.startsWith("/user")) {
      res.end(JSON.stringify({ login: "octocat", id: 1 }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ message: "not found" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address !== null && typeof address === "object") {
    serverUrl = "http://127.0.0.1:" + address.port;
  }
}, 120_000);

afterAll(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (home !== "") await rm(home, { recursive: true, force: true });
  if (workspace !== "") await rm(workspace, { recursive: true, force: true });
  if (fakeGitDir !== "") await rm(fakeGitDir, { recursive: true, force: true });
  if (fixture !== "") await rm(join(fixture, ".."), { recursive: true, force: true });
});

describe("kestrel end-to-end workflow", () => {
  it("find → accept → prepare → commit → complete", async () => {
    const find = await runCli(["find", "--mood", "QUICK_WIN"]);
    expect(find.status).toBe(0);
    expect(find.stdout).toContain("Fix crash on startup");

    const accept = await runCli(["mission", "accept"]);
    expect(accept.status).toBe(0);
    expect(accept.stdout).toContain("ACCEPTED");

    const prepare = await runCli(["mission", "prepare"]);
    expect(prepare.status).toBe(0);
    expect(prepare.stdout).toContain("IN_PROGRESS");

    const repo = await findRepo();
    await writeFile(join(repo, "fix.txt"), "fixed\n", "utf8");
    await runGit(repo, ["add", "fix.txt"]);
    await runGit(repo, ["commit", "-m", "fix the bug"]);

    const complete = await runCli(["mission", "complete"]);
    expect(complete.status).toBe(0);
    expect(complete.stdout).toContain("COMPLETED");
  }, 60_000);

  it("records an immutable agent brief handoff", async () => {
    const accept = await runCli(["mission", "accept"]);
    expect(accept.status).toBe(0);

    const brief = await runCli(["agent", "brief", "--hypothesis", "a null deref"]);
    expect(brief.status).toBe(0);
    expect(brief.stdout).toContain("Handoff");
  }, 60_000);

  it("never renders a credential token in command output", async () => {
    const result = await runCli(["find", "--mood", "QUICK_WIN"]);
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).not.toContain("FAKE_TOKEN_XYZ");
  }, 30_000);

  it("classifies a corrupt journey ledger without crashing", async () => {
    await mkdir(join(home, "journey"), { recursive: true });
    await writeFile(join(home, "journey", "events.jsonl"), "{ not json", "utf8");
    const result = await runCli(["--json", "journey"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("DM_STATE_CORRUPTED");
  });
});
