import { createKestrelError } from "../../application/errors/kestrel-error.js";
import type { RepositoryIdentity } from "../../domain/challenge/repository-identity.js";
import type { GitClient, LocalChanges } from "../../ports/git-client.js";
import type { ProcessRunner } from "../../ports/process-runner.js";
import { mapGitExitCode, mapGitProcessError } from "./git-error-mapper.js";

const GITHUB_REMOTE = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/;

function parseGitHubIdentity(url: string): RepositoryIdentity {
  const match = GITHUB_REMOTE.exec(url.trim());
  if (match === null) {
    throw createKestrelError({
      code: "DM_GIT_FATAL",
      category: "EXTERNAL_STATE_CHANGED",
      userMessage: "The repository remote is not a GitHub URL",
      suggestedActions: ["Verify the upstream remote URL"],
      retryability: "NO_RETRY",
      recoveryStrategy: "MANUAL_INTERVENTION",
      severity: "ERROR",
    });
  }
  return { provider: "github", owner: match[1] as string, name: match[2] as string };
}

export class SystemGitClient implements GitClient {
  constructor(
    private readonly cwd: string,
    private readonly runner: ProcessRunner,
  ) {}

  async isAvailable(): Promise<boolean> {
    try {
      const result = await this.runner.run({ executable: "git", args: ["--version"] });
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

  async getRepositoryIdentity(): Promise<RepositoryIdentity> {
    const result = await this.runGit(["remote", "get-url", "origin"]);
    return parseGitHubIdentity(result.stdout);
  }

  async getCurrentBranch(): Promise<string> {
    const result = await this.runGit(["branch", "--show-current"]);
    return result.stdout.trim();
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
      result = await this.runner.run({ executable: "git", args, cwd: this.cwd });
    } catch (error) {
      throw mapGitProcessError(error);
    }
    if (result.exitCode !== 0) {
      throw mapGitExitCode(result.exitCode, result.stderr);
    }
    return result;
  }
}
