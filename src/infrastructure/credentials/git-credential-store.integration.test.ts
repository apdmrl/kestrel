import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { authenticateGitHub } from "../../application/auth/authenticate-github.js";
import { redactSecrets } from "../../application/errors/kestrel-error.js";
import type {
  DeviceFlowAuthorization,
  GitHubGateway,
  GitHubToken,
  GitHubViewer,
  IssueLinkResult,
  MergeInfo,
  PullRequestInfo,
} from "../../ports/github-gateway.js";
import type { RepositoryIdentity } from "../../domain/challenge/repository-identity.js";
import { ExecaProcessRunner } from "../process/execa-process-runner.js";
import { GitCredentialStore } from "./git-credential-store.js";

class FakeGateway implements GitHubGateway {
  seenTokens: string[] = [];

  async beginDeviceFlow(): Promise<DeviceFlowAuthorization> {
    throw new Error("unused");
  }
  async pollForToken(): Promise<GitHubToken> {
    throw new Error("unused");
  }
  async getViewer(token: string): Promise<GitHubViewer> {
    this.seenTokens.push(token);
    return { login: "octocat", id: 1 };
  }
  async getPullRequest(): Promise<PullRequestInfo> {
    throw new Error("unused");
  }
  async getIssueLinkage(): Promise<IssueLinkResult | undefined> {
    return undefined;
  }
  async getMergeInfo(_r: RepositoryIdentity, _n: number): Promise<MergeInfo> {
    throw new Error("unused");
  }
}

describe("GitCredentialStore integration with the real process runner", () => {
  it("delivers the raw token to the auth use case while diagnostics stay redacted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kestrel-creds-"));
    const previousPath = process.env.PATH;
    try {
      await writeFile(
        join(dir, "git"),
        [
          "#!/usr/bin/env bash",
          'if [ "$1" = "credential" ] && [ "$2" = "fill" ]; then',
          "  printf 'username=octocat\\npassword=REAL_TOKEN_123\\n'",
          "  exit 0",
          "fi",
          'if [ "$1" = "config" ]; then',
          "  printf 'fake-helper\\n'",
          "  exit 0",
          "fi",
          "exit 0",
          "",
        ].join("\n"),
        "utf8",
      );
      await chmod(join(dir, "git"), 0o755);
      process.env.PATH = dir + ":" + (previousPath ?? "");

      const runner = new ExecaProcessRunner();
      const store = new GitCredentialStore(runner);

      const credential = await store.get("github", "octocat");
      expect(credential?.token).toBe("REAL_TOKEN_123");

      const gateway = new FakeGateway();
      const auth = await authenticateGitHub(
        { credentialStore: store, gateway },
        { account: "octocat" },
      );
      expect(auth.token).toBe("REAL_TOKEN_123");
      expect(gateway.seenTokens).toEqual(["REAL_TOKEN_123"]);

      const redacted = redactSecrets({ stdout: "username=octocat\npassword=REAL_TOKEN_123" });
      expect(JSON.stringify(redacted)).not.toContain("REAL_TOKEN_123");
      expect(redacted).toEqual({ stdout: "username=octocat\npassword=***" });
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});
