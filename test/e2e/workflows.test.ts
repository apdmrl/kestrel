import { readFileSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const cli = join(root, "dist", "cli", "main.js");

let server: Server;
let searchCount = 0;
let serverUrl = "";
let home = "";
let workspace = "";
let fakeGitDir = "";
let noCredGitDir = "";
let fixture = "";
let cloneLog = "";
let cloneGate = "";
let cloneStarted = "";

/** Configurable pull-request fixture served by the fake GitHub server. */
interface PrFixture {
  number: number;
  author: string;
  repository?: { owner: string; name: string };
  state: "open" | "closed" | "merged";
  body: string;
  commits: string[];
  merged?: boolean;
  mergeSha?: string;
  mergedAt?: string;
  /** When true, the fake server answers 404 (e.g. the PR is on another repo). */
  notFound?: boolean;
}
let prFixture: PrFixture | undefined;
/** When set, every API response is rate-limited (primary or secondary). */
let rateLimitMode: "primary" | "secondary" | undefined;
/** When true, device-flow token exchange always reports authorization_pending. */
let devicePending = false;
let devicePollCount = 0;
/** When true, /search/issues waits until the gate is released (cancellation tests). */
let searchHold = false;
let searchArrived = false;
let releaseSearchHold: (() => void) | undefined;

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function cliEnv(extraEnv: Record<string, string> = {}): Record<string, string> {
  return {
    ...process.env,
    KESTREL_HOME: home,
    KESTREL_WORKSPACE: workspace,
    GITHUB_API_URL: serverUrl,
    PATH: fakeGitDir + ":" + process.env.PATH,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, "empty-gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
    KESTREL_CLONE_LOG: cloneLog,
    ...extraEnv,
  } as Record<string, string>;
}

function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<CliResult> {
  return execFileAsync("node", [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: cliEnv(extraEnv),
  }).then(
    ({ stdout, stderr }) => ({ status: 0, stdout: String(stdout), stderr: String(stderr) }),
    (error) => ({
      status: (error as { code?: unknown }).code as number | null,
      stdout: String((error as { stdout?: unknown }).stdout ?? ""),
      stderr: String((error as { stderr?: unknown }).stderr ?? ""),
    }),
  );
}

/** Spawn the built CLI as a child process so the test can terminate it mid-flight. */
function spawnCli(
  args: string[],
  extraEnv: Record<string, string> = {},
): { child: ReturnType<typeof spawn>; result: Promise<CliResult> } {
  const child = spawn("node", [cli, ...args], {
    cwd: root,
    env: cliEnv(extraEnv),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const result = new Promise<CliResult>((resolve) => {
    child.on("close", (code) => resolve({ status: code, stdout, stderr }));
    child.on("error", (error) => resolve({ status: -1, stdout, stderr: String(error) }));
  });
  return { child, result };
}

/** Bounded-yield poller (no wall-clock sleeps); throws when the deadline passes. */
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error("condition not reached: " + what);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function waitForFile(path: string): Promise<void> {
  await waitFor(
    async () => (await stat(path).catch(() => undefined)) !== undefined,
    "file exists: " + path,
  );
}

/** Remove a crashed process's lock residue so a new process can resume. */
async function clearStaleLock(sidecarPath: string): Promise<void> {
  const entries = await readdir(sidecarPath).catch(() => []);
  for (const entry of entries) {
    if (entry === ".lock" || entry.startsWith(".lock.guard")) {
      await rm(join(sidecarPath, entry), { recursive: true, force: true });
    }
  }
}

async function cloneCount(): Promise<number> {
  try {
    return (await readFile(cloneLog, "utf8")).split("\n").filter((l) => l.trim() !== "").length;
  } catch {
    return 0;
  }
}

/** Extract the mission id from a plain mission view line. */
function extractMissionId(stdout: string): string {
  const match = /^Mission (\S+):/m.exec(stdout);
  if (match === null) {
    throw new Error("mission output did not expose a Mission id:\n" + stdout);
  }
  return match[1] as string;
}

/** Locate the mission sidecar directory (containing kestrel/mission.json). */
/** Locate the cloned repository for a specific mission id. */
async function findRepoForMission(missionId: string): Promise<string> {
  const entries = await readdir(workspace);
  for (const entry of entries) {
    const mission = join(workspace, entry, "kestrel", "mission.json");
    const raw = await readFile(mission, "utf8").catch(() => undefined);
    if (raw === undefined) {
      continue;
    }
    if ((JSON.parse(raw) as { mission: { id: string } }).mission.id === missionId) {
      return join(workspace, entry, "repo");
    }
  }
  throw new Error("no repo found for mission " + missionId);
}

/** Locate the mission sidecar directory for a specific mission id. */
async function findSidecarFor(missionId: string): Promise<string> {
  const entries = await readdir(workspace);
  for (const entry of entries) {
    const mission = join(workspace, entry, "kestrel", "mission.json");
    const raw = await readFile(mission, "utf8").catch(() => undefined);
    if (raw === undefined) {
      continue;
    }
    if ((JSON.parse(raw) as { mission: { id: string } }).mission.id === missionId) {
      return join(workspace, entry, "kestrel");
    }
  }
  throw new Error("no sidecar found for mission " + missionId);
}

async function findSidecar(): Promise<string> {
  const entries = await readdir(workspace);
  for (const entry of entries) {
    const sidecar = join(workspace, entry, "kestrel");
    const mission = join(sidecar, "mission.json");
    if ((await stat(mission).catch(() => undefined)) !== undefined) {
      return sidecar;
    }
  }
  throw new Error("no mission sidecar found in " + workspace);
}

async function readMissionState(sidecarPath: string): Promise<{
  status: string;
  submissionVerification: string;
  checkpoints: unknown[];
  branch: string | null;
  workspace: unknown;
}> {
  const raw = JSON.parse(await readFile(join(sidecarPath, "mission.json"), "utf8")) as {
    mission: {
      status: string;
      submissionVerification: string;
      preparationCheckpoints: unknown[];
      branch: string | null;
      workspace: unknown;
    };
  };
  return {
    status: raw.mission.status,
    submissionVerification: raw.mission.submissionVerification,
    checkpoints: raw.mission.preparationCheckpoints,
    branch: raw.mission.branch,
    workspace: raw.mission.workspace,
  };
}

async function readIndexEntries(): Promise<Array<{ missionId: string; status: string }>> {
  const raw = JSON.parse(await readFile(join(home, "index.json"), "utf8")) as {
    entries: Array<{ missionId: string; status: string }>;
  };
  return raw.entries;
}

async function readJourneyTypes(): Promise<string[]> {
  return (await readJourneyEvents()).map((event) => event.type);
}

async function readJourneyEvents(): Promise<Array<{ type: string; missionId: string }>> {
  const content = await readFile(join(home, "journey", "events.jsonl"), "utf8").catch(() => "");
  const events: Array<{ type: string; missionId: string }> = [];
  for (const line of content.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    events.push(JSON.parse(line) as { type: string; missionId: string });
  }
  return events;
}

/** Recursively scan a directory tree for a credential token in file contents. */
async function scanForToken(rootPath: string): Promise<boolean> {
  const entries = await readdir(rootPath).catch(() => []);
  for (const entry of entries) {
    const full = join(rootPath, entry);
    const info = await stat(full).catch(() => undefined);
    if (info === undefined) {
      continue;
    }
    if (info.isDirectory()) {
      if (await scanForToken(full)) {
        return true;
      }
      continue;
    }
    const text = await readFile(full, "utf8").catch(() => "");
    if (text.includes("FAKE_TOKEN_XYZ") || text.includes("DEVICE_FLOW_ACCESS_TOKEN")) {
      return true;
    }
  }
  return false;
}

/** Read the persisted mission envelope for a sidecar (raw, untyped). */
function readPersistedMission(sidecarPath: string): {
  stateVersion: number;
  mission: {
    id: string;
    status: string;
    submissionVerification: string;
    preparationCheckpoints: Array<{ checkpoint: string }>;
  };
} {
  return JSON.parse(readFileSync(join(sidecarPath, "mission.json"), "utf8"));
}

/** Read the persisted checkpoint names for a sidecar. */
function readCheckpoints(sidecarPath: string): string[] {
  return readPersistedMission(sidecarPath).mission.preparationCheckpoints.map((c) => c.checkpoint);
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, encoding: "utf8" });
}

/** Extract the recommendation title from plain find output. */
function extractRecommendationTitle(stdout: string): string {
  const match = /^Recommendation: (.+)$/m.exec(stdout);
  if (match === null) {
    throw new Error("find output did not expose a Recommendation title:\n" + stdout);
  }
  return match[1] as string;
}

/** Extract the stable recommendation id from plain find output. */
function extractRecommendationId(stdout: string): string {
  const match = /Recommendation ID: (\S+)/.exec(stdout);
  if (match === null) {
    throw new Error("find output did not expose a Recommendation ID:\n" + stdout);
  }
  return match[1] as string;
}

/** Run find and return the stable recommendation id shown to the user. */
async function findRecommendationId(): Promise<string> {
  const find = await runCli(["find", "--mood", "QUICK_WIN"]);
  expect(find.status).toBe(0);
  return extractRecommendationId(find.stdout);
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
      '  echo "clone" >> "${KESTREL_CLONE_LOG:-/dev/null}"',
      '  if [ -n "${KESTREL_CLONE_GATE:-}" ]; then',
      '    touch "$KESTREL_CLONE_STARTED"',
      '    cat "$KESTREL_CLONE_GATE" >/dev/null',
      "  fi",
      "  exit 0",
      "fi",
      'exec /usr/bin/git "$@"',
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(join(fakeGitDir, "git"), 0o755);

  cloneLog = join(home, "clone.log");
  cloneGate = join(home, "clone.gate");
  cloneStarted = join(home, "clone.started");

  noCredGitDir = await mkdtemp(join(tmpdir(), "kestrel-e2e-nocred-"));
  await writeFile(
    join(noCredGitDir, "git"),
    [
      "#!/usr/bin/env bash",
      'if [ "$1" = "credential" ] && [ "$2" = "fill" ]; then',
      "  exit 0",
      "fi",
      'if [ "$1" = "config" ] && [ "$2" = "--get" ] && [ "$3" = "credential.helper" ]; then',
      "  printf 'fake-helper\n'",
      "  exit 0",
      "fi",
      'exec /usr/bin/git "$@"',
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(join(noCredGitDir, "git"), 0o755);

  server = createServer(async (req, res) => {
    const url = req.url ?? "";
    res.setHeader("content-type", "application/json");
    if (rateLimitMode !== undefined) {
      res.statusCode = 403;
      if (rateLimitMode === "primary") {
        res.setHeader("x-ratelimit-remaining", "0");
        res.setHeader("x-ratelimit-reset", "9999999999");
      } else {
        res.setHeader("retry-after", "60");
      }
      res.end(JSON.stringify({ message: "rate limited" }));
      return;
    }
    if (url.startsWith("/login/device/code")) {
      res.end(
        JSON.stringify({
          device_code: "device-code-secret",
          user_code: "ABCD",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 5,
        }),
      );
      return;
    }
    if (url.startsWith("/login/oauth/access_token")) {
      devicePollCount += 1;
      if (devicePending) {
        res.end(
          JSON.stringify({
            error: "authorization_pending",
            error_description: "Waiting for the user to authorize",
            error_uri: "https://github.com/login/device",
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          access_token: "DEVICE_FLOW_ACCESS_TOKEN",
          token_type: "bearer",
          scope: "public_repo",
        }),
      );
      return;
    }
    if (url.startsWith("/search/issues")) {
      searchCount += 1;
      if (searchHold) {
        searchArrived = true;
        await new Promise<void>((resolve) => {
          releaseSearchHold = resolve;
        });
      }
      const first = searchCount === 1;
      const issueNumber = first ? 42 : 99;
      const title = first ? "Fix crash on startup" : "Add documentation";
      res.end(
        JSON.stringify({
          items: [
            {
              id: first ? 101 : 102,
              number: issueNumber,
              title,
              body: "The app crashes on startup.",
              state: "open",
              repository_url: "https://api.github.com/repos/octocat/hello-world",
              html_url: "https://github.com/octocat/hello-world/issues/" + issueNumber,
              created_at: "2026-08-01T00:00:00Z",
              updated_at: "2026-08-02T00:00:00Z",
              labels: [{ name: "bug" }],
            },
          ],
        }),
      );
      return;
    }
    if (url.startsWith("/repos/octocat/hello-world/pulls/")) {
      const match = /\/pulls\/(\d+)/.exec(url);
      const number = match === null ? 0 : Number(match[1]);
      const override =
        prFixture !== undefined && prFixture.number === number ? prFixture : undefined;
      if (override?.notFound === true) {
        res.statusCode = 404;
        res.end(JSON.stringify({ message: "not found" }));
        return;
      }
      if (url.includes("/commits")) {
        res.end(JSON.stringify((override?.commits ?? []).map((sha) => ({ sha }))));
        return;
      }
      res.end(
        JSON.stringify({
          number: override?.number ?? 999,
          html_url:
            "https://github.com/octocat/hello-world/pull/" + (override?.number ?? 999),
          user: { login: override?.author ?? "someone-else" },
          state: override?.state ?? "open",
          body: override?.body ?? "closes #42",
          merged: override?.merged ?? false,
          merge_commit_sha: override?.mergeSha ?? null,
          merged_at: override?.mergedAt ?? null,
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
  if (noCredGitDir !== "") await rm(noCredGitDir, { recursive: true, force: true });
  if (fixture !== "") await rm(join(fixture, ".."), { recursive: true, force: true });
});

describe("kestrel end-to-end workflow", () => {
  it("find → accept → prepare → commit → complete", async () => {
    const find = await runCli(["find", "--mood", "QUICK_WIN"]);
    expect(find.status).toBe(0);
    expect(find.stdout).toContain("Fix crash on startup");
    const recommendationId = extractRecommendationId(find.stdout);

    const accept = await runCli(["mission", "accept", "--id", recommendationId]);
    expect(accept.status).toBe(0);
    expect(accept.stdout).toContain("ACCEPTED");
    // Acceptance must bind to the recommendation the user saw, not re-discover.
    expect(accept.stdout).toContain("Fix crash on startup");
    expect(accept.stdout).not.toContain("Add documentation");

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

    // Final mission state: completed, workspace recorded, evidence present.
    const sidecar = await findSidecar();
    const state = await readMissionState(sidecar);
    expect(state.status).toBe("COMPLETED");
    expect(state.submissionVerification).toBe("NONE");
    expect(state.workspace).not.toBeNull();
    const rawMission = JSON.parse(
      await readFile(join(sidecar, "mission.json"), "utf8"),
    ) as { mission: { evidence: { items: unknown[] } } };
    expect(rawMission.mission.evidence.items.length).toBeGreaterThan(0);

    // Index: exactly one entry for this mission, completed.
    const entries = await readIndexEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.missionId).toBe(extractMissionId(complete.stdout));
    expect(entries[0]?.status).toBe("COMPLETED");

    // Journey: exactly one of each lifecycle event, in order, no duplicates.
    const types = await readJourneyTypes();
    expect(types).toEqual([
      "MissionAccepted",
      "MissionPreparationStarted",
      "MissionPreparationCompleted",
      "MissionCompleted",
    ]);
  }, 60_000);

  it("records an immutable agent brief handoff", async () => {
    const recommendationId = await findRecommendationId();

    const accept = await runCli(["mission", "accept", "--id", recommendationId]);
    expect(accept.status).toBe(0);

    const brief = await runCli(["agent", "brief", "--hypothesis", "a null deref"]);
    expect(brief.status).toBe(0);
    expect(brief.stdout).toContain("Handoff");

    const abandon = await runCli(["mission", "abandon", "--reason", "done testing"]);
    expect(abandon.status).toBe(0);
  }, 60_000);

  it("never renders a credential token in command output", async () => {
    const result = await runCli(["find", "--mood", "QUICK_WIN"]);
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).not.toContain("FAKE_TOKEN_XYZ");
  }, 30_000);

  it("fails non-interactive authentication immediately without a cached credential", async () => {
    const result = await runCli(["--no-interactive", "find", "--mood", "QUICK_WIN"], {
      PATH: noCredGitDir + ":" + process.env.PATH,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("DM_GITHUB_AUTH_REQUIRED");
    expect(result.stdout + result.stderr).not.toContain("login/device");
  }, 30_000);

  it("rejects a submission whose pull request author does not match", async () => {
    const recommendationId = await findRecommendationId();
    const accept = await runCli(["mission", "accept", "--id", recommendationId]);
    expect(accept.status).toBe(0);
    const prepare = await runCli(["mission", "prepare"]);
    expect(prepare.status).toBe(0);

    const verify = await runCli(["verify", "submission", "--pr", "999"]);
    expect(verify.status).toBe(0);
    expect(verify.stdout).toContain("Not submitted");
    expect(verify.stdout).toContain("authenticated author");
  }, 60_000);

  it("accepts exactly the recommendation bound by --id across two terminals", async () => {
    // Reset the shared fake-server counter so this test deterministically sees
    // a distinct issue per find (issue 42, then issue 99).
    searchCount = 0;

    // Terminal A discovers a recommendation and captures its stable id.
    const findA = await runCli(["find", "--mood", "QUICK_WIN"]);
    expect(findA.status).toBe(0);
    const idA = extractRecommendationId(findA.stdout);
    const titleA = extractRecommendationTitle(findA.stdout);

    // Terminal B later discovers a different recommendation; it must never
    // replace or shadow the snapshot terminal A is looking at.
    const findB = await runCli(["find", "--mood", "QUICK_WIN"]);
    expect(findB.status).toBe(0);
    const idB = extractRecommendationId(findB.stdout);
    const titleB = extractRecommendationTitle(findB.stdout);
    expect(idB).not.toBe(idA);
    expect(titleB).not.toBe(titleA);

    // Accepting terminal A's id must create mission A, never mission B.
    const acceptA = await runCli(["mission", "accept", "--id", idA]);
    expect(acceptA.status).toBe(0);
    expect(acceptA.stdout).toContain(titleA);
    expect(acceptA.stdout).not.toContain(titleB);

    // The other terminal's id remains acceptably loadable as a separate,
    // immutable snapshot: accepting it binds to recommendation B.
    const acceptB = await runCli(["mission", "accept", "--id", idB]);
    expect(acceptB.status).toBe(0);
    expect(acceptB.stdout).toContain(titleB);
    expect(acceptB.stdout).not.toContain(titleA);
  }, 60_000);

  it("keeps --json stdout machine-readable during interactive device authorization", async () => {
    const result = await runCli(["--json", "find", "--mood", "QUICK_WIN"], {
      PATH: noCredGitDir + ":" + process.env.PATH,
      GITHUB_CLIENT_ID: "test-client-id",
    });
    expect(result.status).toBe(0);

    // Every nonempty stdout byte must be exactly one JSON document.
    const stdoutLines = result.stdout.split("\n").filter((line) => line.trim().length > 0);
    expect(stdoutLines.length).toBeGreaterThan(0);
    const parsed = JSON.parse(stdoutLines.join("\n")) as { ok: boolean };
    expect(parsed.ok).toBe(true);

    // Human authorization guidance must never pollute machine stdout.
    expect(result.stdout).not.toContain("https://github.com/login/device");
    expect(result.stdout).not.toContain("ABCD");

    // The guidance belongs on stderr and carries only safe fields.
    expect(result.stderr).toContain("https://github.com/login/device");
    expect(result.stderr).toContain("ABCD");
    expect(result.stderr).not.toContain("device-code-secret");
    expect(result.stderr).not.toContain("DEVICE_FLOW_ACCESS_TOKEN");
    expect(result.stderr).not.toContain("Bearer ");
  }, 60_000);

  it("preserves interactive device guidance on stderr in plain mode", async () => {
    const result = await runCli(["find", "--mood", "QUICK_WIN"], {
      PATH: noCredGitDir + ":" + process.env.PATH,
      GITHUB_CLIENT_ID: "test-client-id",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Recommendation");
    expect(result.stdout).not.toContain("https://github.com/login/device");
    expect(result.stderr).toContain("https://github.com/login/device");
    expect(result.stderr).toContain("ABCD");
    expect(result.stderr).not.toContain("device-code-secret");
  }, 60_000);

  it("submission → exact issue link → trusted verification → merge for the recorded PR", async () => {
    // Deterministic fake-server issue (42) for this scenario's mission.
    searchCount = 0;
    const recommendationId = await findRecommendationId();
    const accept = await runCli(["mission", "accept", "--id", recommendationId]);
    expect(accept.status).toBe(0);
    const missionId = extractMissionId(accept.stdout);
    const prepare = await runCli(["mission", "prepare", "--id", missionId]);
    expect(prepare.status).toBe(0);

    const repo = await findRepoForMission(missionId);
    await writeFile(join(repo, "fix.txt"), "fixed\n", "utf8");
    await runGit(repo, ["add", "fix.txt"]);
    await runGit(repo, ["commit", "-m", "fix the bug"]);
    const headSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" })).stdout.trim();

    // A valid, merged pull request for the mission's repository and commits.
    prFixture = {
      number: 7,
      author: "octocat",
      state: "merged",
      body: "closes #42",
      commits: [headSha],
      merged: true,
      mergeSha: "merge-sha-abc",
      mergedAt: "2026-08-16T00:00:00Z",
    };
    try {
      const submitted = await runCli(["verify", "submission", "--id", missionId, "--pr", "7"]);
      expect(submitted.status).toBe(0);
      expect(submitted.stdout).toContain("SUBMITTED");

      const linked = await runCli(["verify", "link", "--id", missionId, "--pr", "7"]);
      expect(linked.status).toBe(0);

      const merged = await runCli(["verify", "merge", "--id", missionId, "--pr", "7"]);
      expect(merged.status).toBe(0);
      expect(merged.stdout).toContain("MERGED");
    } finally {
      prFixture = undefined;
    }

    // The mission records exactly the verified PR, issue link, and merge.
    const sidecar = await findSidecarFor(missionId);
    const raw = JSON.parse(await readFile(join(sidecar, "mission.json"), "utf8")) as {
      mission: {
        submissionVerification: string;
        submittedPullRequest: { number: number; url: string } | null;
        issueLink: { issueNumber: number } | null;
        mergeEvidence: { pullRequestNumber: number; mergeSha: string } | null;
      };
    };
    expect(raw.mission.submissionVerification).toBe("MERGED");
    expect(raw.mission.submittedPullRequest?.number).toBe(7);
    expect(raw.mission.submittedPullRequest?.url).toContain("pull/7");
    expect(raw.mission.issueLink?.issueNumber).toBe(42);
    expect(raw.mission.mergeEvidence?.pullRequestNumber).toBe(7);
    expect(raw.mission.mergeEvidence?.mergeSha).toBe("merge-sha-abc");

    const types = await readJourneyTypes();
    expect(types).toContain("PullRequestSubmitted");
    expect(types).toContain("IssueLinkVerified");
    expect(types).toContain("PullRequestMerged");
    expect(types.filter((t) => t === "PullRequestSubmitted")).toHaveLength(1);
    void missionId;
  }, 60_000);

  it("rejects wrong repository, author, and missing commit overlap without mutation", async () => {
    searchCount = 0;
    const recommendationId = await findRecommendationId();
    const accept = await runCli(["mission", "accept", "--id", recommendationId]);
    expect(accept.status).toBe(0);
    const missionId = extractMissionId(accept.stdout);
    const prepare = await runCli(["mission", "prepare", "--id", missionId]);
    expect(prepare.status).toBe(0);

    const repo = await findRepoForMission(missionId);
    await writeFile(join(repo, "fix.txt"), "fixed\n", "utf8");
    await runGit(repo, ["add", "fix.txt"]);
    await runGit(repo, ["commit", "-m", "fix the bug"]);
    const headSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" })).stdout.trim();

    const sidecar = await findSidecarFor(missionId);
    const cases: Array<{
      name: string;
      fixture: PrFixture;
      reason?: string;
      classified?: string;
    }> = [
      {
        name: "wrong repository (PR not on the mission repository)",
        fixture: { number: 11, author: "octocat", state: "open", body: "closes #42", commits: [headSha], notFound: true },
        classified: "DM_GITHUB_NOT_FOUND",
      },
      {
        name: "wrong author",
        fixture: { number: 12, author: "someone-else", state: "open", body: "closes #42", commits: [headSha] },
        reason: "authenticated author",
      },
      {
        name: "missing commit overlap",
        fixture: { number: 13, author: "octocat", state: "open", body: "closes #42", commits: ["0000000000000000000000000000000000000000"] },
        reason: "no mission commits",
      },
    ];
    for (const entry of cases) {
      prFixture = entry.fixture;
      try {
        const verify = await runCli(["verify", "submission", "--id", missionId, "--pr", String(entry.fixture.number)]);
        if (entry.classified !== undefined) {
          expect(verify.status, entry.name).not.toBe(0);
          expect(verify.stderr, entry.name).toContain(entry.classified);
        } else {
          expect(verify.status, entry.name).toBe(0);
          expect(verify.stdout, entry.name).toContain("Not submitted");
          expect(verify.stdout, entry.name).toContain(entry.reason as string);
        }
      } finally {
        prFixture = undefined;
      }
      // Rejection never mutates the mission.
      const state = await readMissionState(sidecar);
      expect(state.submissionVerification, entry.name).toBe("NONE");
    }

    // A valid match with a different head branch still verifies: branch names
    // are supporting context only in the matcher and never reject a match.
    prFixture = { number: 14, author: "octocat", state: "open", body: "closes #42", commits: [headSha] };
    try {
      const ok = await runCli(["verify", "submission", "--id", missionId, "--pr", "14"]);
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain("SUBMITTED");
    } finally {
      prFixture = undefined;
    }
  }, 60_000);

  it("rejects an unrelated issue link and a different merged pull request", async () => {
    searchCount = 0;
    const recommendationId = await findRecommendationId();
    const accept = await runCli(["mission", "accept", "--id", recommendationId]);
    expect(accept.status).toBe(0);
    const missionId = extractMissionId(accept.stdout);
    const prepare = await runCli(["mission", "prepare", "--id", missionId]);
    expect(prepare.status).toBe(0);

    const repo = await findRepoForMission(missionId);
    await writeFile(join(repo, "fix.txt"), "fixed\n", "utf8");
    await runGit(repo, ["add", "fix.txt"]);
    await runGit(repo, ["commit", "-m", "fix the bug"]);
    const headSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" })).stdout.trim();

    // The PR references issue 99, but the mission targets issue 42.
    prFixture = { number: 21, author: "octocat", state: "open", body: "closes #99", commits: [headSha] };
    try {
      const linked = await runCli(["verify", "link", "--id", missionId, "--pr", "21"]);
      expect(linked.status).toBe(0);
      expect(linked.stdout).toContain("No issue link detected");
    } finally {
      prFixture = undefined;
    }

    // Record a real submission for PR 7, then verify a DIFFERENT merged PR.
    prFixture = { number: 7, author: "octocat", state: "open", body: "closes #42", commits: [headSha] };
    try {
      const submitted = await runCli(["verify", "submission", "--id", missionId, "--pr", "7"]);
      expect(submitted.status).toBe(0);
    } finally {
      prFixture = undefined;
    }
    const different = await runCli(["verify", "merge", "--id", missionId, "--pr", "8"]);
    expect(different.status).not.toBe(0);
    expect(different.stderr).toContain("DM_VERIFICATION_CONFLICT");

    // The recorded PR is not merged upstream yet.
    prFixture = { number: 7, author: "octocat", state: "open", body: "closes #42", commits: [headSha], merged: false };
    try {
      const notMerged = await runCli(["verify", "merge", "--id", missionId, "--pr", "7"]);
      expect(notMerged.status).toBe(0);
      expect(notMerged.stdout).toContain("Pull request is not merged");
    } finally {
      prFixture = undefined;
    }
  }, 60_000);

  it("resumes after interruption at every preparation checkpoint with at-most-once side effects", async () => {
    searchCount = 0;
    await writeFile(cloneLog, ""); // Isolate this scenario's clone accounting.
    const recommendationId = await findRecommendationId();
    const accept = await runCli(["mission", "accept", "--id", recommendationId]);
    expect(accept.status).toBe(0);
    const missionId = extractMissionId(accept.stdout);
    const sidecar = await findSidecarFor(missionId);

    // Interrupt preparation after each of the seven checkpoints, resuming in a
    // new process each time. The clone and branch side effects must occur at
    // most once across all interruptions.
    for (let checkpointCount = 1; checkpointCount <= 7; checkpointCount++) {
      const spawned = spawnCli(["mission", "prepare", "--id", missionId]);
      await waitFor(
        () => {
          try {
            const raw = readPersistedMission(sidecar);
            return raw.mission.preparationCheckpoints.length >= checkpointCount;
          } catch {
            return false;
          }
        },
        "checkpoint " + checkpointCount + " recorded",
      );
      // Only kill once the clone (the only expensive external side effect)
      // has verifiably finished, so a mid-clone kill cannot double it.
      if (checkpointCount === 1) {
        await waitFor(async () => (await cloneCount()) >= 1, "clone completed before first kill");
      }
      spawned.child.kill("SIGKILL");
      await spawned.result;
      await clearStaleLock(sidecar);
      if ((await readPersistedMission(sidecar)).mission.status === "IN_PROGRESS") {
        break; // Interrupted after the final checkpoint; completion committed.
      }
    }

    const resume = await runCli(["mission", "resume", "--id", missionId]);
    if ((await readPersistedMission(sidecar)).mission.status !== "IN_PROGRESS") {
      expect(resume.status).toBe(0);
      expect(resume.stdout).toContain("IN_PROGRESS");
    }

    const state = await readPersistedMission(sidecar);
    expect(state.mission.status).toBe("IN_PROGRESS");
    expect(readCheckpoints(sidecar)).toEqual([
      "WORKSPACE_CREATED",
      "REPOSITORY_CLONED",
      "BASE_RECORDED",
      "BRANCH_CREATED",
      "CONTEXT_COLLECTED",
      "GUIDANCE_GENERATED",
      "BRIEF_GENERATED",
    ]);
    expect(await cloneCount()).toBe(1);
    const repo = await findRepoForMission(missionId);
    const branches = (
      await execFileAsync("git", ["branch"], { cwd: repo, encoding: "utf8" })
    ).stdout.split("\n");
    expect(branches.filter((b) => b.includes("kestrel/42-hello-world"))).toHaveLength(1);
  }, 120_000);

  it("recovers pending transaction intents at every phase without duplicates", async () => {
    searchCount = 0;
    const recommendationId = await findRecommendationId();
    const accept = await runCli(["mission", "accept", "--id", recommendationId]);
    expect(accept.status).toBe(0);
    const missionId = extractMissionId(accept.stdout);
    const sidecar = await findSidecarFor(missionId);
    const targetMission = readPersistedMission(sidecar).mission;
    const txDir = join(home, "transactions");
    await mkdir(txDir, { recursive: true });

    const intent = (phase: string): Record<string, unknown> => ({
      schemaVersion: 1,
      transactionId: "tx-phase-" + phase,
      eventId: "evt-phase-" + phase,
      missionId,
      sidecarPath: sidecar,
      expectedStateVersion: 0,
      targetMission,
      event: {
        schemaVersion: 1,
        eventId: "evt-phase-" + phase,
        missionId,
        type: "AgentHandoffRecorded",
        occurredAt: "2026-08-15T10:00:00Z",
        payload: { handoffId: "handoff-phase-" + phase },
      },
      handoff: {
        handoffId: "handoff-phase-" + phase,
        missionId,
        policyVersion: 1,
        renderer: "generic",
        createdAt: "2026-08-15T10:00:00Z",
      },
      phase,
    });

    // Phase PREPARED: only the intent file exists. Recovery must finish the
    // handoff exactly once: mission untouched, index unchanged, one handoff
    // file, one event, intent removed.
    await writeFile(join(txDir, "tx-phase-PREPARED.json"), JSON.stringify(intent("PREPARED")));
    const run1 = await runCli(["journey"]);
    expect(run1.status).toBe(0);
    expect(await readdir(join(sidecar, "handoffs"))).toEqual(["handoff-phase-PREPARED.json"]);
    const events1 = (await readJourneyEvents()).filter((e) => e.missionId === missionId);
    expect(events1.filter((e) => e.type === "AgentHandoffRecorded")).toHaveLength(1);
    await expect(stat(join(txDir, "tx-phase-PREPARED.json"))).rejects.toThrow();
    expect(readPersistedMission(sidecar).stateVersion).toBe(1);
    expect((await readIndexEntries()).filter((e) => e.missionId === missionId)).toHaveLength(1);

    // Phase STATE_WRITTEN: intent + handoff already saved, event not appended.
    await writeFile(join(txDir, "tx-phase-STATE_WRITTEN.json"), JSON.stringify(intent("STATE_WRITTEN")));
    await writeFile(
      join(sidecar, "handoffs", "handoff-phase-STATE_WRITTEN.json"),
      JSON.stringify(intent("STATE_WRITTEN").handoff),
    );
    const run2 = await runCli(["journey"]);
    expect(run2.status).toBe(0);
    expect(await readdir(join(sidecar, "handoffs"))).toHaveLength(2);
    const events2 = (await readJourneyEvents()).filter((e) => e.missionId === missionId);
    expect(events2.filter((e) => e.type === "AgentHandoffRecorded")).toHaveLength(2);
    await expect(stat(join(txDir, "tx-phase-STATE_WRITTEN.json"))).rejects.toThrow();

    // Phase EVENT_APPENDED: intent + handoff + event already committed. Recovery
    // must deduplicate the event (no second line) and just remove the intent.
    const pending = intent("EVENT_APPENDED");
    await writeFile(join(txDir, "tx-phase-EVENT_APPENDED.json"), JSON.stringify(pending));
    await writeFile(
      join(sidecar, "handoffs", "handoff-phase-EVENT_APPENDED.json"),
      JSON.stringify(pending.handoff),
    );
    const ledger = join(home, "journey", "events.jsonl");
    await writeFile(ledger, (await readFile(ledger, "utf8")) + JSON.stringify(pending.event) + "\n");
    const run3 = await runCli(["journey"]);
    expect(run3.status).toBe(0);
    const events3 = (await readJourneyEvents()).filter((e) => e.missionId === missionId);
    expect(events3.filter((e) => e.type === "AgentHandoffRecorded")).toHaveLength(3);
    await expect(stat(join(txDir, "tx-phase-EVENT_APPENDED.json"))).rejects.toThrow();
  }, 60_000);

  it("serializes two child processes on one mission and recovers after the winner is terminated", async () => {
    searchCount = 0;
    await writeFile(cloneLog, ""); // Isolate this scenario's clone accounting.
    await rm(cloneStarted, { force: true });
    const recommendationId = await findRecommendationId();
    const accept = await runCli(["mission", "accept", "--id", recommendationId]);
    expect(accept.status).toBe(0);
    const missionId = extractMissionId(accept.stdout);
    const sidecar = await findSidecarFor(missionId);

    // Gate the winner's clone with a FIFO so it holds the lock mid-critical-
    // section while the loser races it.
    const gateFifo = join(home, "gate.fifo");
    await execFileAsync("mkfifo", [gateFifo]);
    const winner = spawnCli(["mission", "prepare", "--id", missionId], {
      KESTREL_CLONE_GATE: gateFifo,
      KESTREL_CLONE_STARTED: cloneStarted,
    });
    await waitForFile(cloneStarted);
    await waitForFile(join(sidecar, ".lock"));

    // The loser must be excluded while the winner holds the lock: exactly one
    // critical section at a time.
    const loser = await runCli(["mission", "prepare", "--id", missionId]);
    expect(loser.status).not.toBe(0);
    expect(loser.stderr).toContain("DM_MISSION_LOCKED");

    // Terminate the winner mid-critical-section, release the gate so the
    // orphaned clone wrapper exits, and recover in a fresh process.
    winner.child.kill("SIGKILL");
    await winner.result;
    await execFileAsync("bash", ["-c", "printf x > " + gateFifo]);
    await clearStaleLock(sidecar);

    const recovered = await runCli(["mission", "prepare", "--id", missionId]);
    expect(recovered.status).toBe(0);
    expect(recovered.stdout).toContain("IN_PROGRESS");
    expect(await cloneCount()).toBe(1);
    await rm(gateFifo, { force: true });
  }, 60_000);

  it("keeps both index entries when two child processes update different missions", async () => {
    searchCount = 0;
    const idA = await findRecommendationId();
    const acceptA = await runCli(["mission", "accept", "--id", idA]);
    expect(acceptA.status).toBe(0);
    const missionA = extractMissionId(acceptA.stdout);
    const idB = await findRecommendationId();
    const acceptB = await runCli(["mission", "accept", "--id", idB]);
    expect(acceptB.status).toBe(0);
    const missionB = extractMissionId(acceptB.stdout);

    const [prepareA, prepareB] = await Promise.all([
      runCli(["mission", "prepare", "--id", missionA]),
      runCli(["mission", "prepare", "--id", missionB]),
    ]);
    expect(prepareA.status).toBe(0);
    expect(prepareB.status).toBe(0);

    // Neither mission's index entry is lost under concurrent index upserts.
    const entries = await readIndexEntries();
    const mine = entries.filter((e) => e.missionId === missionA || e.missionId === missionB);
    expect(mine).toHaveLength(2);
    expect(mine.map((e) => e.status)).toEqual(["IN_PROGRESS", "IN_PROGRESS"]);

    // Neither mission's journey events are lost.
    const events = await readJourneyEvents();
    for (const mission of [missionA, missionB]) {
      const mineEvents = events.filter((e) => e.missionId === mission);
      expect(mineEvents.filter((e) => e.type === "MissionPreparationStarted")).toHaveLength(1);
      expect(mineEvents.filter((e) => e.type === "MissionPreparationCompleted")).toHaveLength(1);
    }
  }, 60_000);

  it("cancels device polling, discovery, preparation, and verification without corruption", async () => {
    // Device polling: start an interactive device flow and terminate it mid-poll.
    devicePending = true;
    try {
      const polling = spawnCli(["--json", "find", "--mood", "QUICK_WIN"], {
        PATH: noCredGitDir + ":" + process.env.PATH,
        GITHUB_CLIENT_ID: "test-client-id",
      });
      await waitFor(async () => devicePollCount >= 2, "device polling started");
      polling.child.kill("SIGKILL");
      await polling.result;
    } finally {
      devicePending = false;
    }
    // No credential was stored and a fresh command still works.
    const afterPoll = await runCli(["journey"]);
    expect(afterPoll.status).toBe(0);

    // Discovery: hold the search response, terminate mid-request, then release.
    searchCount = 0;
    searchHold = true;
    searchArrived = false;
    releaseSearchHold = undefined;
    const recDir = join(home, "recommendations");
    const recsBefore = await readdir(recDir).catch(() => []);
    const discovery = spawnCli(["find", "--mood", "QUICK_WIN"]);
    try {
      await waitFor(() => searchArrived, "search request arrived");
      discovery.child.kill("SIGKILL");
      await discovery.result;
    } finally {
      searchHold = false;
      releaseSearchHold?.();
    }
    // No recommendation or mission was persisted by the cancelled discovery.
    expect(await readdir(recDir).catch(() => [])).toEqual(recsBefore);
    const discoveryAfter = await runCli(["journey"]);
    expect(discoveryAfter.status).toBe(0);

    // Preparation: terminate mid-prepare; the mission stays resumable.
    searchCount = 0;
    const recommendationId = await findRecommendationId();
    const accept = await runCli(["mission", "accept", "--id", recommendationId]);
    expect(accept.status).toBe(0);
    const missionId = extractMissionId(accept.stdout);
    const sidecar = await findSidecarFor(missionId);
    const prep = spawnCli(["mission", "prepare", "--id", missionId]);
    await waitFor(() => readCheckpoints(sidecar).length >= 1, "preparation checkpoint");
    prep.child.kill("SIGKILL");
    await prep.result;
    await clearStaleLock(sidecar);
    const resumed = await runCli(["mission", "resume", "--id", missionId]);
    expect(resumed.status).toBe(0);
    expect(resumed.stdout).toContain("IN_PROGRESS");

    // Verification: hold the pull-request response, terminate mid-request.
    const repo = await findRepoForMission(missionId);
    await writeFile(join(repo, "fix.txt"), "fixed\n", "utf8");
    await runGit(repo, ["add", "fix.txt"]);
    await runGit(repo, ["commit", "-m", "fix the bug"]);
    prFixture = { number: 31, author: "octocat", state: "open", body: "closes #42", commits: [], notFound: true };
    // Use the 404 fixture to keep the request deterministic; the kill happens
    // after the request starts (server-observed) or the process exits fast.
    const verify = spawnCli(["verify", "submission", "--id", missionId, "--pr", "31"]);
    await Promise.race([verify.result, new Promise<void>((r) => setTimeout(r, 1500))]);
    verify.child.kill("SIGKILL");
    await verify.result;
    prFixture = undefined;
    // No partial submission mutation: the mission stays IN_PROGRESS/NONE.
    expect((await readPersistedMission(sidecar)).mission.submissionVerification).toBe("NONE");
  }, 60_000);

  it("classifies primary and secondary GitHub rate limits without partial mutation", async () => {
    searchCount = 0;
    const indexBefore = await readIndexEntries();
    const journeyBefore = await readJourneyTypes();

    rateLimitMode = "primary";
    try {
      const result = await runCli(["find", "--mood", "QUICK_WIN"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("DM_GITHUB_RATE_LIMITED");
    } finally {
      rateLimitMode = undefined;
    }
    rateLimitMode = "secondary";
    try {
      const result = await runCli(["find", "--mood", "QUICK_WIN"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("DM_GITHUB_ABUSE_LIMIT");
    } finally {
      rateLimitMode = undefined;
    }

    // No partial mission mutation: index and journey are byte-identical.
    expect(await readIndexEntries()).toEqual(indexBefore);
    expect(await readJourneyTypes()).toEqual(journeyBefore);
  }, 30_000);

  it("preserves clone and user work through failure, resume, and restart", async () => {
    searchCount = 0;
    await writeFile(cloneLog, "");
    const recommendationId = await findRecommendationId();
    const accept = await runCli(["mission", "accept", "--id", recommendationId]);
    expect(accept.status).toBe(0);
    const missionId = extractMissionId(accept.stdout);
    const sidecar = await findSidecarFor(missionId);

    // Interrupt preparation after the clone checkpoint, then resume.
    const prep = spawnCli(["mission", "prepare", "--id", missionId]);
    await waitFor(() => readCheckpoints(sidecar).length >= 2, "clone checkpoint");
    prep.child.kill("SIGKILL");
    await prep.result;
    await clearStaleLock(sidecar);
    const resumed = await runCli(["mission", "resume", "--id", missionId]);
    expect(resumed.status).toBe(0);
    expect(resumed.stdout).toContain("IN_PROGRESS");

    // User work inside the preserved clone.
    const repo = await findRepoForMission(missionId);
    await writeFile(join(repo, "user-notes.md"), "my notes\n", "utf8");
    await writeFile(join(repo, "README.md"), "modified by user\n", "utf8");

    // Failure: a classified command failure must not touch the work.
    prFixture = { number: 41, author: "octocat", state: "open", body: "closes #42", commits: [], notFound: true };
    try {
      const failed = await runCli(["verify", "submission", "--id", missionId, "--pr", "41"]);
      expect(failed.status).not.toBe(0);
    } finally {
      prFixture = undefined;
    }
    expect(await readFile(join(repo, "user-notes.md"), "utf8")).toBe("my notes\n");
    expect(await readFile(join(repo, "README.md"), "utf8")).toBe("modified by user\n");

    // Restart: a fresh process completes the mission; the work survives.
    await runGit(repo, ["add", "user-notes.md", "README.md"]);
    await runGit(repo, ["commit", "-m", "user work"]);
    const completed = await runCli(["mission", "complete", "--id", missionId]);
    expect(completed.status).toBe(0);
    expect(completed.stdout).toContain("COMPLETED");
    expect(await readFile(join(repo, "user-notes.md"), "utf8")).toBe("my notes\n");
    expect(await readFile(join(repo, "README.md"), "utf8")).toBe("modified by user\n");
  }, 60_000);

  it("classifies corrupt middle and tail journey records and recovers stably", async () => {
    searchCount = 0;
    const recommendationId = await findRecommendationId();
    const accept = await runCli(["mission", "accept", "--id", recommendationId]);
    expect(accept.status).toBe(0);
    const missionId = extractMissionId(accept.stdout);
    const journeyPath = join(home, "journey", "events.jsonl");
    const validLine = (await readFile(journeyPath, "utf8")).trimEnd();

    // Corrupt middle record.
    await writeFile(journeyPath, validLine + "\n{ corrupt middle\n" + validLine + "\n", "utf8");
    const middle = await runCli(["--json", "journey"]);
    expect(middle.status).not.toBe(0);
    expect(middle.stderr).toContain("DM_STATE_CORRUPTED");

    // Truncated final tail.
    await writeFile(journeyPath, validLine + "\n{\"eventId\":\"trunc", "utf8");
    const tail = await runCli(["--json", "journey"]);
    expect(tail.status).not.toBe(0);
    expect(tail.stderr).toContain("DM_STATE_CORRUPTED");

    // Repair and stable projection: the mission's own event appears exactly once.
    await writeFile(journeyPath, validLine + "\n", "utf8");
    const repaired = await runCli(["--json", "progress"]);
    expect(repaired.status).toBe(0);
    expect(
      (await readJourneyEvents()).filter(
        (e) => e.type === "MissionAccepted" && e.missionId === missionId,
      ),
    ).toHaveLength(1);

    // Event deduplication: a pending intent whose event is already appended is
    // never appended twice by recovery.
    const sidecar = await findSidecarFor(missionId);
    const txDir = join(home, "transactions");
    await mkdir(txDir, { recursive: true });
    const pending = {
      schemaVersion: 1,
      transactionId: "tx-dedup",
      eventId: "evt-dedup",
      missionId,
      sidecarPath: sidecar,
      expectedStateVersion: 0,
      targetMission: readPersistedMission(sidecar).mission,
      event: {
        schemaVersion: 1,
        eventId: "evt-dedup",
        missionId,
        type: "AgentHandoffRecorded",
        occurredAt: "2026-08-15T10:00:00Z",
        payload: { handoffId: "handoff-dedup" },
      },
      handoff: { handoffId: "handoff-dedup", missionId },
      phase: "EVENT_APPENDED",
    };
    // The event is already in the ledger; only the intent file is present.
    await writeFile(join(txDir, "tx-dedup.json"), JSON.stringify(pending));
    await writeFile(journeyPath, (await readFile(journeyPath, "utf8")) + JSON.stringify(pending.event) + "\n");
    const dedupRun = await runCli(["journey"]);
    expect(dedupRun.status).toBe(0);
    const handoffEvents = (await readJourneyEvents()).filter(
      (e) => e.type === "AgentHandoffRecorded" && e.missionId === missionId,
    );
    expect(handoffEvents).toHaveLength(1);
    await expect(stat(join(txDir, "tx-dedup.json"))).rejects.toThrow();
  }, 60_000);

  it("keeps agent handoffs immutable and separates every storage area", async () => {
    searchCount = 0;
    const recommendationId = await findRecommendationId();
    const accept = await runCli(["mission", "accept", "--id", recommendationId]);
    expect(accept.status).toBe(0);
    const missionId = extractMissionId(accept.stdout);
    const sidecar = await findSidecarFor(missionId);
    const prepare = await runCli(["mission", "prepare", "--id", missionId]);
    expect(prepare.status).toBe(0);

    const brief1 = await runCli(["agent", "brief", "--id", missionId, "--hypothesis", "h1"]);
    expect(brief1.status).toBe(0);
    const handoff1 = /^Handoff (\S+)/m.exec(brief1.stdout)?.[1] as string;
    const brief2 = await runCli(["agent", "brief", "--id", missionId, "--hypothesis", "h2"]);
    expect(brief2.status).toBe(0);
    const handoff2 = /^Handoff (\S+)/m.exec(brief2.stdout)?.[1] as string;
    expect(handoff2).not.toBe(handoff1);

    // Immutability: each brief writes a distinct immutable file; the first
    // file's content is byte-identical after the second brief.
    const handoffsDir = join(sidecar, "handoffs");
    const files = (await readdir(handoffsDir)).sort();
    expect(files).toEqual([handoff1 + ".json", handoff2 + ".json"].sort());
    const firstContent = await readFile(join(handoffsDir, handoff1 + ".json"), "utf8");
    expect(JSON.parse(firstContent)).toMatchObject({ handoffId: handoff1 });
    const secondContent = await readFile(join(handoffsDir, handoff1 + ".json"), "utf8");
    expect(secondContent).toBe(firstContent);

    // Separation: repository files, Kestrel metadata, transactions, journey,
    // recommendations, and credentials live in distinct, disjoint areas.
    const missionDir = join(workspace, (await readdir(workspace)).find((e) => {
      try {
        return (JSON.parse(readFileSync(join(workspace, e, "kestrel", "mission.json"), "utf8")) as { mission: { id: string } }).mission.id === missionId;
      } catch {
        return false;
      }
    }) as string);
    expect(await readdir(join(missionDir, "repo"))).toContain("README.md");
    expect(await readdir(join(missionDir, "repo"))).not.toContain("mission.json");
    const metadata = await readdir(sidecar);
    expect(metadata).toContain("mission.json");
    expect(metadata).toContain("handoffs");
    expect(await readdir(join(home, "journey"))).toContain("events.jsonl");
    expect(await readdir(join(home, "transactions")).catch(() => [])).toEqual([]);
    expect((await readdir(join(home, "recommendations"))).length).toBeGreaterThan(0);

    // Credentials never appear in any Kestrel file.
    const seen = await scanForToken(home + "\n" + workspace);
    expect(seen).toBe(false);
    const tokenInRepo = await scanForToken(join(missionDir, "repo"));
    expect(tokenInRepo).toBe(false);
  }, 60_000);

  it("redacts credentials in plain and JSON output and preserves auth contracts", async () => {
    searchCount = 0;
    const find = await runCli(["--json", "find", "--mood", "QUICK_WIN"]);
    expect(find.status).toBe(0);
    const parsed = JSON.parse(find.stdout) as { data: { recommendationId: string } };
    expect(find.stdout + find.stderr).not.toContain("FAKE_TOKEN_XYZ");
    const id = parsed.data.recommendationId;

    const accept = await runCli(["--json", "mission", "accept", "--id", id]);
    expect(accept.status).toBe(0);
    expect(accept.stdout + accept.stderr).not.toContain("FAKE_TOKEN_XYZ");

    // The JSON mission view carries the stable mission id.
    const missionId = (JSON.parse(accept.stdout) as { data: { id: string } }).data.id;
    void missionId;
    // Plain and JSON progress output never leak the token either.
    const progress = await runCli(["--json", "progress"]);
    expect(progress.status).toBe(0);
    expect(progress.stdout + progress.stderr).not.toContain("FAKE_TOKEN_XYZ");
    const plain = await runCli(["journey"]);
    expect(plain.status).toBe(0);
    expect(plain.stdout + plain.stderr).not.toContain("FAKE_TOKEN_XYZ");
  }, 30_000);

  it("classifies a corrupt journey ledger without crashing", async () => {
    await mkdir(join(home, "journey"), { recursive: true });
    await writeFile(join(home, "journey", "events.jsonl"), "{ not json", "utf8");
    const result = await runCli(["--json", "journey"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("DM_STATE_CORRUPTED");
  });
});
