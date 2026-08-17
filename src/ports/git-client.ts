import type { RepositoryIdentity } from "../domain/challenge/repository-identity.js";

export interface LocalChanges {
  readonly commits: readonly string[];
  readonly headSha: string;
  readonly filesChanged: readonly string[];
  readonly insertions: number;
  readonly deletions: number;
  readonly workingTreeState: "CLEAN" | "DIRTY";
}

/** System Git inspection operations, scoped to a repository working directory. */
export interface GitClient {
  isAvailable(): Promise<boolean>;
  clone(url: string, targetDir: string): Promise<void>;
  getDefaultBranch(): Promise<string>;
  getHeadSha(): Promise<string>;
  createBranch(branchName: string): Promise<void>;
  getRepositoryIdentity(): Promise<RepositoryIdentity>;
  collectChangesSince(baseSha: string): Promise<LocalChanges>;
  getCurrentBranch(): Promise<string>;
  commitExists(sha: string): Promise<boolean>;
}
