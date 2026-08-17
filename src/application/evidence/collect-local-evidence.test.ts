import { describe, expect, it } from "vitest";
import type { GitClient, LocalChanges } from "../../ports/git-client.js";
import type { RepositoryIdentity } from "../../domain/challenge/repository-identity.js";
import { collectLocalEvidence } from "./collect-local-evidence.js";

const repository: RepositoryIdentity = {
  provider: "github",
  owner: "octocat",
  name: "hello-world",
};

class FakeGit implements GitClient {
  changes: LocalChanges = {
    commits: [],
    headSha: "head",
    filesChanged: [],
    insertions: 0,
    deletions: 0,
    workingTreeState: "CLEAN",
  };
  baseExists = true;
  identity: RepositoryIdentity = repository;

  async isAvailable() {
    return true;
  }
  async clone(): Promise<void> {}
  async getDefaultBranch() {
    return "main";
  }
  async getHeadSha() {
    return "head";
  }
  async createBranch(): Promise<void> {}
  async branchExists(): Promise<boolean> {
    return false;
  }
  async checkoutBranch(): Promise<void> {}
  async getRepositoryIdentity(): Promise<RepositoryIdentity> {
    return this.identity;
  }
  async collectChangesSince(): Promise<LocalChanges> {
    return this.changes;
  }
  async getCurrentBranch() {
    return "main";
  }
  async commitExists(_sha: string): Promise<boolean> {
    return this.baseExists;
  }
}

describe("collectLocalEvidence", () => {
  it("returns committed and tracked changes", async () => {
    const git = new FakeGit();
    git.changes = {
      commits: ["c1"],
      headSha: "head",
      filesChanged: ["a.ts"],
      insertions: 3,
      deletions: 1,
      workingTreeState: "DIRTY",
    };
    const evidence = await collectLocalEvidence({ git }, { repository, baseSha: "base" });
    expect(evidence.commits).toEqual(["c1"]);
    expect(evidence.workingTreeState).toBe("DIRTY");
    expect(evidence.insertions).toBe(3);
  });

  it("returns empty evidence for no work", async () => {
    const evidence = await collectLocalEvidence(
      { git: new FakeGit() },
      { repository, baseSha: "base" },
    );
    expect(evidence.commits).toEqual([]);
    expect(evidence.filesChanged).toEqual([]);
    expect(evidence.workingTreeState).toBe("CLEAN");
  });

  it("classifies a missing base SHA", async () => {
    const git = new FakeGit();
    git.baseExists = false;
    await expect(
      collectLocalEvidence({ git }, { repository, baseSha: "gone" }),
    ).rejects.toMatchObject({
      code: "DM_BASE_SHA_MISSING",
    });
  });

  it("classifies a repository identity mismatch", async () => {
    const git = new FakeGit();
    git.identity = { provider: "github", owner: "someone", name: "else" };
    await expect(
      collectLocalEvidence({ git }, { repository, baseSha: "base" }),
    ).rejects.toMatchObject({
      code: "DM_REPOSITORY_MISMATCH",
    });
  });
});
