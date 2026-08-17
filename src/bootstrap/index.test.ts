import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChallenge } from "../domain/challenge/challenge.js";
import type { Challenge } from "../domain/challenge/challenge.js";
import { createEvaluationContext } from "../domain/challenge/evaluation-context.js";
import type { ChallengeId } from "../domain/shared/identifiers.js";
import type { IsoDateTime } from "../domain/shared/time.js";
import type { ChallengeSource } from "../ports/challenge-source.js";
import type { Credential, CredentialStore } from "../ports/credential-store.js";
import type {
  DeviceFlowAuthorization,
  GitHubGateway,
  GitHubToken,
  GitHubViewer,
  IssueLinkResult,
  MergeInfo,
  PullRequestInfo,
} from "../ports/github-gateway.js";
import { bootstrap, createConfig } from "./index.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kestrel-boot-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("bootstrap", () => {
  it("resolves the config from environment", () => {
    const config = createConfig({
      KESTREL_HOME: "/tmp/home",
      KESTREL_WORKSPACE: "/tmp/ws",
      GITHUB_CLIENT_ID: "client-id",
    });
    expect(config.home).toBe("/tmp/home");
    expect(config.workspaceRoot).toBe("/tmp/ws");
    expect(config.githubClientId).toBe("client-id");
  });

  it("returns an empty journey without credentials", async () => {
    const handlers = await bootstrap(createConfig({ KESTREL_HOME: dir }));
    const view = await handlers.journey();
    expect(view.kind).toBe("journey");
    if (view.kind === "journey") {
      expect(view.entries).toEqual([]);
    }
  });

  it("resolves no active mission without credentials", async () => {
    const handlers = await bootstrap(createConfig({ KESTREL_HOME: dir }));
    const view = await handlers.missionCurrent();
    expect(view.kind).toBe("verification");
  });

  it("returns zero progress counts on a fresh home", async () => {
    const handlers = await bootstrap(createConfig({ KESTREL_HOME: dir }));
    const view = await handlers.progress();
    expect(view.kind).toBe("progress");
    if (view.kind === "progress") {
      expect(view.counts.accepted).toBe(0);
      expect(view.counts.completed).toBe(0);
    }
  });

  it("returns default preferences on a fresh home", async () => {
    const handlers = await bootstrap(createConfig({ KESTREL_HOME: dir }));
    const view = await handlers.preferencesGet();
    expect(view.kind).toBe("preferences");
    if (view.kind === "preferences") {
      expect(view.defaultMode).toBe("GUIDED");
      expect(view.preferredLanguages).toEqual([]);
    }
  });

  it("find fails with USER_ACTION_REQUIRED instead of a hard-coded auth error", async () => {
    const previous = {
      HOME: process.env.HOME,
      GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT,
    };
    try {
      // Isolate git credential resolution so no user helper returns a token.
      process.env.HOME = dir;
      process.env.GIT_CONFIG_NOSYSTEM = "1";
      process.env.GIT_CONFIG_GLOBAL = join(dir, "empty-gitconfig");
      process.env.GIT_TERMINAL_PROMPT = "0";
      const handlers = await bootstrap(createConfig({ KESTREL_HOME: dir }));
      await expect(handlers.find({ mood: "QUICK_WIN" })).rejects.toMatchObject({
        code: "DM_GITHUB_AUTH_REQUIRED",
      });
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});

class FakeCredentialStore implements CredentialStore {
  credential: Credential | undefined;
  readonly deleted: string[] = [];
  readonly stored: Credential[] = [];

  async get(): Promise<Credential | undefined> {
    return this.credential;
  }

  async store(credential: Credential): Promise<void> {
    this.stored.push(credential);
    this.credential = credential;
  }

  async delete(_service: string, account: string): Promise<void> {
    this.deleted.push(account);
    if (this.credential?.account === account) {
      this.credential = undefined;
    }
  }
}

class FakeGateway implements GitHubGateway {
  deviceFlowCalls = 0;
  viewerFn: (token: string) => GitHubViewer = () => ({ login: "octocat", id: 1 });

  async beginDeviceFlow(): Promise<DeviceFlowAuthorization> {
    this.deviceFlowCalls += 1;
    return {
      deviceCode: "device-code-secret",
      userCode: "ABCD",
      verificationUri: "https://github.com/login/device",
      expiresInSeconds: 900,
      intervalSeconds: 5,
    };
  }

  async pollForToken(): Promise<GitHubToken> {
    return { token: "fresh-token", account: "octocat" };
  }

  async getViewer(token: string): Promise<GitHubViewer> {
    return this.viewerFn(token);
  }

  async getPullRequest(): Promise<PullRequestInfo> {
    throw new Error("unused");
  }

  async getIssueLinkage(): Promise<IssueLinkResult | undefined> {
    return undefined;
  }

  async getMergeInfo(): Promise<MergeInfo> {
    return { merged: false, mergeSha: undefined, mergedAt: undefined };
  }
}

const emptyChallengeSource: ChallengeSource = {
  async search() {
    return [];
  },
  async enrich() {
    return {
      observedAt: "2026-08-15T10:00:00Z" as IsoDateTime,
      repositoryHealth: 1,
      repositoryInterest: undefined,
      contributionGuide: undefined,
      competingWork: undefined,
      maintainerActivity: undefined,
      issueQuality: undefined,
      confidence: 1,
    };
  },
};

describe("bootstrap github authentication", () => {
  it("defaults device authorization guidance to stderr, never stdout", async () => {
    const store = new FakeCredentialStore();
    const gateway = new FakeGateway();
    const written: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      });
    try {
      const handlers = await bootstrap(createConfig({ KESTREL_HOME: dir, GITHUB_CLIENT_ID: "cid" }), {
        interactive: true,
        credentialStore: store,
        gateway,
        challengeSourceFactory: () => emptyChallengeSource,
      });
      await handlers.find({ mood: "QUICK_WIN" });
    } finally {
      stderrSpy.mockRestore();
    }
    const output = written.join("\n");
    expect(output).toContain("https://github.com/login/device");
    expect(output).toContain("ABCD");
    expect(output).not.toContain("device-code-secret");
    expect(output).not.toContain("fresh-token");
  });

  it("presents the verification URI and user code during interactive device flow", async () => {
    const written: string[] = [];
    const store = new FakeCredentialStore();
    const gateway = new FakeGateway();
    const handlers = await bootstrap(createConfig({ KESTREL_HOME: dir, GITHUB_CLIENT_ID: "cid" }), {
      interactive: true,
      writeAuth: (text) => written.push(text),
      credentialStore: store,
      gateway,
      challengeSourceFactory: () => emptyChallengeSource,
    });
    await handlers.find({ mood: "QUICK_WIN" });
    const output = written.join("\n");
    expect(output).toContain("https://github.com/login/device");
    expect(output).toContain("ABCD");
    expect(output).not.toContain("device-code-secret");
    expect(output).not.toContain("fresh-token");
  });

  it("fails immediately in non-interactive mode without a cached token", async () => {
    const store = new FakeCredentialStore();
    const gateway = new FakeGateway();
    const handlers = await bootstrap(createConfig({ KESTREL_HOME: dir, GITHUB_CLIENT_ID: "cid" }), {
      interactive: false,
      credentialStore: store,
      gateway,
      challengeSourceFactory: () => emptyChallengeSource,
    });
    await expect(handlers.find({ mood: "QUICK_WIN" })).rejects.toMatchObject({
      code: "DM_GITHUB_AUTH_REQUIRED",
    });
    expect(gateway.deviceFlowCalls).toBe(0);
  });

  it("reuses a validated cached token without starting device flow", async () => {
    const store = new FakeCredentialStore();
    store.credential = { service: "github", account: "octocat", token: "cached-token" };
    const gateway = new FakeGateway();
    const seen: string[] = [];
    gateway.viewerFn = (token) => {
      seen.push(token);
      return { login: "octocat", id: 1 };
    };
    const handlers = await bootstrap(createConfig({ KESTREL_HOME: dir }), {
      credentialStore: store,
      gateway,
      challengeSourceFactory: () => emptyChallengeSource,
    });
    await handlers.find({ mood: "QUICK_WIN" });
    expect(seen).toEqual(["cached-token"]);
    expect(gateway.deviceFlowCalls).toBe(0);
  });
});

function makeChallenge(issueNumber: number, title: string): Challenge {
  const result = createChallenge({
    id: ("challenge-" + issueNumber) as ChallengeId,
    externalId: String(issueNumber),
    repository: { provider: "github", owner: "octocat", name: "hello-world" },
    issueNumber,
    canonicalUrl: "https://github.com/octocat/hello-world/issues/" + issueNumber,
    title,
    description: "d",
    type: "BUG_FIX",
    labels: ["bug"],
    createdAt: "2026-08-01T00:00:00Z" as IsoDateTime,
    updatedAt: "2026-08-01T00:00:00Z" as IsoDateTime,
  });
  if (!result.ok) {
    throw new Error("expected ok");
  }
  return result.value;
}

function evaluationContext() {
  const result = createEvaluationContext({
    observedAt: "2026-08-15T10:00:00Z" as IsoDateTime,
    repositoryHealth: 0.8,
    confidence: 0.6,
  });
  if (!result.ok) {
    throw new Error("expected ok");
  }
  return result.value;
}

function sequencingSource(challenges: Challenge[]): {
  source: ChallengeSource;
  searches: () => number;
} {
  let calls = 0;
  let count = 0;
  const source: ChallengeSource = {
    async search() {
      count += 1;
      const challenge = challenges[Math.min(calls, challenges.length - 1)];
      calls += 1;
      return challenge === undefined ? [] : [challenge];
    },
    async enrich() {
      return evaluationContext();
    },
  };
  return { source, searches: () => count };
}

describe("bootstrap recommendation binding", () => {
  function authDeps() {
    const store = new FakeCredentialStore();
    store.credential = { service: "github", account: "octocat", token: "cached-token" };
    return { store, gateway: new FakeGateway() };
  }

  it("binds mission accept to the recommendation shown by find", async () => {
    const { store, gateway } = authDeps();
    const challengeA = makeChallenge(42, "Fix crash on startup");
    const challengeB = makeChallenge(99, "Add documentation");
    const { source, searches } = sequencingSource([challengeA, challengeB]);

    const handlers = await bootstrap(
      createConfig({ KESTREL_HOME: dir, KESTREL_WORKSPACE: join(dir, "workspace") }),
      {
        credentialStore: store,
        gateway,
        challengeSourceFactory: () => source,
      },
    );

    const find = await handlers.find({ mood: "QUICK_WIN" });
    expect(find.kind).toBe("recommendation");
    if (find.kind === "recommendation") {
      expect(find.title).toBe("Fix crash on startup");
      expect(find.recommendationId).toBe("challenge-42");
    }

    const accepted = await handlers.missionAccept({ recommendationId: "challenge-42" });
    expect(accepted.kind).toBe("mission");
    if (accepted.kind === "mission") {
      expect(accepted.title).toBe("Fix crash on startup");
    }
    expect(searches()).toBe(1);
  });

  it("rejects a missing, unknown, or malformed recommendation identifier", async () => {
    const { store, gateway } = authDeps();
    const challengeA = makeChallenge(42, "Fix crash on startup");
    const challengeB = makeChallenge(99, "Add documentation");
    const { source } = sequencingSource([challengeA, challengeB]);

    const handlers = await bootstrap(
      createConfig({ KESTREL_HOME: dir, KESTREL_WORKSPACE: join(dir, "workspace") }),
      {
        credentialStore: store,
        gateway,
        challengeSourceFactory: () => source,
      },
    );

    // No recommendation persisted yet.
    await expect(
      handlers.missionAccept({ recommendationId: "challenge-42" }),
    ).rejects.toMatchObject({ code: "DM_RECOMMENDATION_NOT_FOUND" });

    const first = await handlers.find({ mood: "QUICK_WIN" });
    expect(first.kind).toBe("recommendation");

    // Unknown identifier.
    await expect(
      handlers.missionAccept({ recommendationId: "challenge-unknown" }),
    ).rejects.toMatchObject({ code: "DM_RECOMMENDATION_NOT_FOUND" });

    // Malformed identifier (empty).
    await expect(handlers.missionAccept({ recommendationId: "  " })).rejects.toMatchObject({
      code: "DM_ILLEGAL_TRANSITION",
    });

    // A later find writes an immutable separate snapshot: it never supersedes
    // the first recommendation, so the earlier id stays valid.
    await handlers.find({ mood: "QUICK_WIN" });
    const accepted = await handlers.missionAccept({ recommendationId: "challenge-42" });
    expect(accepted.kind).toBe("mission");
    if (accepted.kind === "mission") {
      expect(accepted.title).toBe("Fix crash on startup");
    }
  });
});
