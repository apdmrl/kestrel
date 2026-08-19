import { createKestrelError } from "../../application/errors/kestrel-error.js";
import type { RepositoryIdentity } from "../../domain/challenge/repository-identity.js";
import type { GitClient, LocalChanges } from "../../ports/git-client.js";
import type { ProcessRunner } from "../../ports/process-runner.js";
import { mapGitExitCode, mapGitProcessError } from "./git-error-mapper.js";

const GITHUB_REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;

function githubRemoteError(): never {
  throw createKestrelError({
    code: "DM_GIT_FATAL",
    category: "EXTERNAL_STATE_CHANGED",
    userMessage: "The repository remote is not a supported GitHub URL",
    suggestedActions: ["Verify the upstream remote URL"],
    retryability: "NO_RETRY",
    recoveryStrategy: "MANUAL_INTERVENTION",
    severity: "ERROR",
  });
}

function isRepoSegment(value: string): boolean {
  return GITHUB_REPO_SEGMENT.test(value) && !value.includes("..") && !value.startsWith(".");
}

function stripGitSuffix(name: string): string {
  return name.endsWith(".git") ? name.slice(0, -".git".length) : name;
}

/**
 * Parse a GitHub repository remote structurally. HTTPS and SSH URL forms are
 * parsed with the URL parser and require the exact hostname github.com; the
 * SCP-like git@github.com:owner/name form is validated separately against an
 * anchored prefix. The .git suffix is normalized only after the host has been
 * validated, and credentials, ports, queries, fragments, and encoded segments
 * are all rejected.
 */
export function parseGitHubIdentity(url: string): RepositoryIdentity {
  const trimmed = url.trim();
  let owner: string | undefined;
  let name: string | undefined;

  if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      githubRemoteError();
    }
    if (parsed.protocol !== "https:") {
      githubRemoteError();
    }
    if (parsed.hostname !== "github.com") {
      githubRemoteError();
    }
    if (parsed.username !== "" || parsed.password !== "") {
      githubRemoteError();
    }
    if (parsed.port !== "") {
      githubRemoteError();
    }
    if (parsed.search !== "" || parsed.hash !== "") {
      githubRemoteError();
    }
    const parts = parsed.pathname.split("/").filter((part) => part.length > 0);
    if (parts.length !== 2) {
      githubRemoteError();
    }
    owner = parts[0];
    name = parts[1];
  } else if (trimmed.startsWith("ssh://")) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      githubRemoteError();
    }
    if (parsed.protocol !== "ssh:") {
      githubRemoteError();
    }
    if (parsed.hostname !== "github.com") {
      githubRemoteError();
    }
    if (parsed.username !== "git" || parsed.password !== "") {
      githubRemoteError();
    }
    if (parsed.port !== "") {
      githubRemoteError();
    }
    if (parsed.search !== "" || parsed.hash !== "") {
      githubRemoteError();
    }
    const parts = parsed.pathname.split("/").filter((part) => part.length > 0);
    if (parts.length !== 2) {
      githubRemoteError();
    }
    owner = parts[0];
    name = parts[1];
  } else {
    const match = /^git@github\.com:([^/]+)\/([^/]+)$/.exec(trimmed);
    if (match === null) {
      githubRemoteError();
    }
    owner = match[1];
    name = match[2];
  }

  if (owner === undefined || name === undefined) {
    githubRemoteError();
  }
  if (owner.includes("%") || name.includes("%") || !isRepoSegment(owner)) {
    githubRemoteError();
  }
  name = stripGitSuffix(name);
  if (name.length === 0 || !isRepoSegment(name)) {
    githubRemoteError();
  }
  return { provider: "github", owner, name };
}

export class SystemGitClient implements GitClient {
  constructor(
    private readonly cwd: string,
    private readonly runner: ProcessRunner,
    private readonly signal?: AbortSignal,
  ) {}

  async isAvailable(): Promise<boolean> {
    try {
      const result = await this.runner.run({
        executable: "git",
        args: ["--version"],
        ...(this.signal !== undefined ? { signal: this.signal } : {}),
      });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  async clone(url: string, targetDir: string): Promise<void> {
    await this.runGit(["clone", url, targetDir]);
  }

  async getDefaultBranch(): Promise<string> {
    const result = await this.runGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    const branch = result.stdout.trim();
    return branch.startsWith("origin/") ? branch.slice("origin/".length) : branch;
  }

  async getHeadSha(): Promise<string> {
    const result = await this.runGit(["rev-parse", "HEAD"]);
    return result.stdout.trim();
  }

  async createBranch(branchName: string): Promise<void> {
    await this.runGit(["checkout", "-b", branchName]);
  }

  async branchExists(branchName: string): Promise<boolean> {
    try {
      await this.runGit(["show-ref", "--verify", "--quiet", "refs/heads/" + branchName]);
      return true;
    } catch {
      return false;
    }
  }

  async checkoutBranch(branchName: string): Promise<void> {
    await this.runGit(["checkout", branchName]);
  }

  async getRepositoryIdentity(): Promise<RepositoryIdentity> {
    const result = await this.runGit(["remote", "get-url", "origin"]);
    return parseGitHubIdentity(result.stdout);
  }

  async getCurrentBranch(): Promise<string> {
    const result = await this.runGit(["branch", "--show-current"]);
    return result.stdout.trim();
  }

  async commitExists(sha: string): Promise<boolean> {
    try {
      await this.runGit(["cat-file", "-e", sha + "^{commit}"]);
      return true;
    } catch {
      return false;
    }
  }

  async collectChangesSince(baseSha: string): Promise<LocalChanges> {
    const headSha = await this.getHeadSha();

    const revList = await this.runGit(["rev-list", baseSha + "..HEAD"]);
    const commits = revList.stdout.trim() === "" ? [] : revList.stdout.trim().split("\n");

    const nameOnly = await this.runGit(["diff", "--name-only", "--find-renames", baseSha]);
    const filesChanged = nameOnly.stdout.trim() === "" ? [] : nameOnly.stdout.trim().split("\n");

    const numstat = await this.runGit(["diff", "--numstat", baseSha]);
    let insertions = 0;
    let deletions = 0;
    for (const line of numstat.stdout.split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      const parts = line.split("\t");
      const added = Number(parts[0]);
      const removed = Number(parts[1]);
      if (Number.isFinite(added)) {
        insertions += added;
      }
      if (Number.isFinite(removed)) {
        deletions += removed;
      }
    }

    const status = await this.runGit(["status", "--porcelain"]);
    const workingTreeState = status.stdout.trim() === "" ? "CLEAN" : "DIRTY";

    return {
      commits,
      headSha,
      filesChanged,
      insertions,
      deletions,
      workingTreeState,
    };
  }

  private async runGit(args: string[]) {
    let result;
    try {
      result = await this.runner.run({
        executable: "git",
        args,
        cwd: this.cwd,
        ...(this.signal !== undefined ? { signal: this.signal } : {}),
      });
    } catch (error) {
      throw mapGitProcessError(error);
    }
    if (result.exitCode !== 0) {
      throw mapGitExitCode(result.exitCode, result.stderr);
    }
    return result;
  }
}
