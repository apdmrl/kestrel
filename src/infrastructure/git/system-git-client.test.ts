import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExecaProcessRunner } from "../process/execa-process-runner.js";
import { SystemGitClient } from "./system-git-client.js";

const runner = new ExecaProcessRunner();

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kestrel-git-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runner.run({ executable: "git", args, cwd });
  if (result.exitCode !== 0) {
    throw new Error("git failed: " + result.stderr);
  }
  return result.stdout;
}

async function initRepo(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await git(path, ["init", "-b", "main"]);
  await git(path, ["config", "user.email", "test@example.com"]);
  await git(path, ["config", "user.name", "Test"]);
}

async function setUpstreamWithFile(
  fileName: string,
): Promise<{ upstream: string; working: string }> {
  const upstream = join(dir, "upstream");
  const working = join(dir, "working");
  await initRepo(upstream);
  await writeFile(join(upstream, fileName), "base\n", "utf8");
  await git(upstream, ["add", fileName]);
  await git(upstream, ["commit", "-m", "base"]);
  await new SystemGitClient(dir, runner).clone(upstream, working);
  await git(working, ["remote", "set-url", "origin", "https://github.com/octocat/hello-world.git"]);
  return { upstream, working };
}

describe("SystemGitClient", () => {
  it("clones, inspects identity, default branch, and head SHA", async () => {
    const { working } = await setUpstreamWithFile("README.md");
    const client = new SystemGitClient(working, runner);

    expect(await client.isAvailable()).toBe(true);
    expect(await client.getDefaultBranch()).toBe("main");
    expect((await client.getHeadSha()).length).toBeGreaterThan(0);
    expect(await client.getCurrentBranch()).toBe("main");
    expect(await client.getRepositoryIdentity()).toEqual({
      provider: "github",
      owner: "octocat",
      name: "hello-world",
    });
  });

  it("collects committed and tracked uncommitted changes since base", async () => {
    const { working } = await setUpstreamWithFile("a.txt");
    const client = new SystemGitClient(working, runner);
    const baseSha = (await client.getHeadSha()).trim();

    await writeFile(join(working, "a.txt"), "changed\n", "utf8");
    await git(working, ["add", "a.txt"]);
    await git(working, ["commit", "-m", "change"]);

    const committed = await client.collectChangesSince(baseSha);
    expect(committed.commits).toHaveLength(1);
    expect(committed.filesChanged).toContain("a.txt");
    expect(committed.workingTreeState).toBe("CLEAN");
    expect(committed.headSha).not.toBe(baseSha);

    await writeFile(join(working, "a.txt"), "more\n", "utf8");
    const dirty = await client.collectChangesSince(baseSha);
    expect(dirty.workingTreeState).toBe("DIRTY");
    expect(dirty.insertions).toBeGreaterThan(0);
  });

  it("creates a branch and detects a renamed file", async () => {
    const { working } = await setUpstreamWithFile("old.txt");
    const client = new SystemGitClient(working, runner);
    const baseSha = (await client.getHeadSha()).trim();

    await client.createBranch("kestrel/1-fix");
    expect(await client.getCurrentBranch()).toBe("kestrel/1-fix");

    await git(working, ["mv", "old.txt", "new.txt"]);
    const changes = await client.collectChangesSince(baseSha);
    expect(changes.filesChanged).toContain("new.txt");
    expect(changes.workingTreeState).toBe("DIRTY");
  });

  it("distinguishes tracked unstaged, staged-new, and untracked files", async () => {
    const { working } = await setUpstreamWithFile("a.txt");
    const client = new SystemGitClient(working, runner);
    const baseSha = (await client.getHeadSha()).trim();

    // tracked unstaged change
    await writeFile(join(working, "a.txt"), "unstaged\n", "utf8");
    // staged new file
    await writeFile(join(working, "staged.txt"), "staged\n", "utf8");
    await git(working, ["add", "staged.txt"]);
    // untracked file
    await writeFile(join(working, "untracked.txt"), "untracked\n", "utf8");

    const changes = await client.collectChangesSince(baseSha);
    expect(changes.filesChanged).toContain("a.txt");
    expect(changes.filesChanged).toContain("staged.txt");
    expect(changes.filesChanged).not.toContain("untracked.txt");
    expect(changes.workingTreeState).toBe("DIRTY");
  });

  it("reports untracked-only changes as dirty with no tracked files", async () => {
    const { working } = await setUpstreamWithFile("a.txt");
    const client = new SystemGitClient(working, runner);
    const baseSha = (await client.getHeadSha()).trim();

    await writeFile(join(working, "untracked.txt"), "untracked\n", "utf8");

    const changes = await client.collectChangesSince(baseSha);
    expect(changes.commits).toHaveLength(0);
    expect(changes.filesChanged).toEqual([]);
    expect(changes.workingTreeState).toBe("DIRTY");
  });

  it("reports a clean tree with no changes", async () => {
    const { working } = await setUpstreamWithFile("a.txt");
    const client = new SystemGitClient(working, runner);
    const baseSha = (await client.getHeadSha()).trim();
    const changes = await client.collectChangesSince(baseSha);
    expect(changes.commits).toHaveLength(0);
    expect(changes.filesChanged).toEqual([]);
    expect(changes.workingTreeState).toBe("CLEAN");
  });
});
