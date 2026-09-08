import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChallenge } from "../domain/challenge/challenge.js";
import type { Challenge } from "../domain/challenge/challenge.js";
import { createEvaluationContext } from "../domain/challenge/evaluation-context.js";
import type { ChallengeId } from "../domain/shared/identifiers.js";
import type { IsoDateTime } from "../domain/shared/time.js";
import type { ChallengeSource } from "../ports/challenge-source.js";
import type { BrowserLauncher } from "../ports/browser-launcher.js";
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
    const view = await handlers.journey({}, {});
    expect(view.kind).toBe("journey");
    if (view.kind === "journey") {
      expect(view.entries).toEqual([]);
    }
  });

  it("resolves no active mission without credentials", async () => {
    const handlers = await bootstrap(createConfig({ KESTREL_HOME: dir }));
    const view = await handlers.missionCurrent({}, {});
    expect(view.kind).toBe("verification");
  });

  it("returns zero progress counts on a fresh home", async () => {
    const handlers = await bootstrap(createConfig({ KESTREL_HOME: dir }));
    const view = await handlers.progress({}, {});
    expect(view.kind).toBe("progress");
    if (view.kind === "progress") {
      expect(view.counts.accepted).toBe(0);
      expect(view.counts.completed).toBe(0);
    }
  });

  it("returns default preferences on a fresh home", async () => {
    const handlers = await bootstrap(createConfig({ KESTREL_HOME: dir }));
    const view = await handlers.preferencesGet({}, {});
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
      await expect(handlers.find({ mood: "QUICK_WIN" }, {})).rejects.toMatchObject({
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
  readonly getSignals: AbortSignal[] = [];

  async get(
    _service: string,
    _account: string,
    signal: AbortSignal,
  ): Promise<Credential | undefined> {
    this.getSignals.push(signal);
    return this.credential;
  }

  async store(credential: Credential, _signal: AbortSignal): Promise<void> {
    this.stored.push(credential);
    this.credential = credential;
  }

  async delete(_service: string, account: string, _signal: AbortSignal): Promise<void> {
    this.deleted.push(account);
    if (this.credential?.account === account) {
      this.credential = undefined;
    }
  }
}

class FakeGateway implements GitHubGateway {
  deviceFlowCalls = 0;
  viewerFn: (token: string) => GitHubViewer = () => ({ login: "octocat", id: 1 });
  readonly viewerSignals: AbortSignal[] = [];

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

  async getViewer(token: string, signal?: AbortSignal): Promise<GitHubViewer> {
    if (signal !== undefined) this.viewerSignals.push(signal);
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
  it("fails closed during interactive bootstrap without a cached credential", async () => {
    const store = new FakeCredentialStore();
    const gateway = new FakeGateway();
    let factoryCalls = 0;
    const factory = () => {
      factoryCalls += 1;
      return emptyChallengeSource;
    };
    const handlers = await bootstrap(createConfig({ KESTREL_HOME: dir, GITHUB_CLIENT_ID: "cid" }), {
      interactive: true,
      credentialStore: store,
      gateway,
      challengeSourceFactory: factory,
    });
    await expect(handlers.find({ mood: "QUICK_WIN" }, {})).rejects.toMatchObject({
      code: "DM_GITHUB_AUTH_REQUIRED",
    });
    // The source factory must NOT be invoked when auth is missing: building
    // a challenge source before validating identity would mask the failure
    // and could leak credentials into a half-constructed adapter.
    expect(factoryCalls).toBe(0);
    expect(gateway.deviceFlowCalls).toBe(0);
  });

  it("never writes device-flow authorization to stderr or writeAuth from find", async () => {
    const written: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      });
    try {
      const store = new FakeCredentialStore();
      const gateway = new FakeGateway();
      const handlers = await bootstrap(
        createConfig({ KESTREL_HOME: dir, GITHUB_CLIENT_ID: "cid" }),
        {
          interactive: true,
          writeAuth: (text) => written.push(text),
          credentialStore: store,
          gateway,
          challengeSourceFactory: () => emptyChallengeSource,
        },
      );
      await expect(handlers.find({ mood: "QUICK_WIN" }, {})).rejects.toMatchObject({
        code: "DM_GITHUB_AUTH_REQUIRED",
      });
    } finally {
      stderrSpy.mockRestore();
    }
    const output = written.join("\n");
    expect(output).not.toContain("https://github.com/login/device");
    expect(output).not.toContain("ABCD");
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
    await expect(handlers.find({ mood: "QUICK_WIN" }, {})).rejects.toMatchObject({
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
    await handlers.find({ mood: "QUICK_WIN" }, {});
    expect(seen).toEqual(["cached-token"]);
    expect(gateway.deviceFlowCalls).toBe(0);
  });

  it("forwards the per-invocation context signal through find to the credential port", async () => {
    const store = new FakeCredentialStore();
    store.credential = { service: "github", account: "octocat", token: "cached-token" };
    const gateway = new FakeGateway();
    const handlers = await bootstrap(createConfig({ KESTREL_HOME: dir }), {
      credentialStore: store,
      gateway,
      challengeSourceFactory: () => emptyChallengeSource,
    });
    const controller = new AbortController();
    const commandSignal = controller.signal;
    await handlers.find({ mood: "QUICK_WIN" }, { signal: commandSignal });
    // The signal travels with the per-invocation context, not from any
    // bootstrap-time option. The credential lookup and the viewer validation
    // both observe the same signal instance.
    expect(store.getSignals).toEqual([commandSignal]);
    expect(gateway.viewerSignals).toEqual([commandSignal]);
  });
});

class FakeBrowserLauncher implements BrowserLauncher {
  readonly opened: string[] = [];
  result = true;

  async open(url: string): Promise<boolean> {
    this.opened.push(url);
    return this.result;
  }
}

describe("bootstrap auth commands", () => {
  it("reads KESTREL_NO_BROWSER from the environment", () => {
    expect(createConfig({ KESTREL_HOME: dir }).noBrowser).toBe(false);
    expect(createConfig({ KESTREL_HOME: dir, KESTREL_NO_BROWSER: "1" }).noBrowser).toBe(true);
  });

  it("reports NOT_CONNECTED from authStatus with no stored credential", async () => {
    const handlers = await bootstrap(createConfig({ KESTREL_HOME: dir }), {
      credentialStore: new FakeCredentialStore(),
      gateway: new FakeGateway(),
    });
    const view = await handlers.authStatus({}, {});
    expect(view).toEqual({
      kind: "auth-status",
      connected: false,
      login: null,
      detail: "NOT_CONNECTED",
    });
  });

  it("reports CONNECTED from authStatus for a validated credential", async () => {
    const store = new FakeCredentialStore();
    store.credential = { service: "github", account: "octocat", token: "cached-token" };
    const handlers = await bootstrap(createConfig({ KESTREL_HOME: dir }), {
      credentialStore: store,
      gateway: new FakeGateway(),
    });
    const view = await handlers.authStatus({}, {});
    expect(view).toEqual({
      kind: "auth-status",
      connected: true,
      login: "octocat",
      detail: "CONNECTED",
    });
  });

  it("authLogin stores a token and reports the connected identity", async () => {
    const store = new FakeCredentialStore();
    const gateway = new FakeGateway();
    const handlers = await bootstrap(createConfig({ KESTREL_HOME: dir, GITHUB_CLIENT_ID: "cid" }), {
      credentialStore: store,
      gateway,
      writeAuth: () => undefined,
    });
    const view = await handlers.authLogin({}, {});
    expect(view).toEqual({
      kind: "auth-status",
      connected: true,
      login: "octocat",
      detail: "CONNECTED",
    });
    expect(store.stored).toEqual([{ service: "github", account: "octocat", token: "fresh-token" }]);
  });

  it("authLogin opens the browser at the verification uri", async () => {
    const launcher = new FakeBrowserLauncher();
    const handlers = await bootstrap(createConfig({ KESTREL_HOME: dir, GITHUB_CLIENT_ID: "cid" }), {
      credentialStore: new FakeCredentialStore(),
      gateway: new FakeGateway(),
      browserLauncher: launcher,
      openBrowser: true,
      writeAuth: () => undefined,
    });
    await handlers.authLogin({}, {});
    expect(launcher.opened).toEqual(["https://github.com/login/device"]);
  });

  it("authLogin never passes the device code or token to the browser", async () => {
    const launcher = new FakeBrowserLauncher();
    const handlers = await bootstrap(createConfig({ KESTREL_HOME: dir, GITHUB_CLIENT_ID: "cid" }), {
      credentialStore: new FakeCredentialStore(),
      gateway: new FakeGateway(),
      browserLauncher: launcher,
      openBrowser: true,
      writeAuth: () => undefined,
    });
    await handlers.authLogin({}, {});
    const all = launcher.opened.join(" ");
    expect(all).not.toContain("device-code-secret");
    expect(all).not.toContain("fresh-token");
  });

  it("authLogin does not open the browser when the launch is suppressed", async () => {
    const launcher = new FakeBrowserLauncher();
    const handlers = await bootstrap(createConfig({ KESTREL_HOME: dir, GITHUB_CLIENT_ID: "cid" }), {
      credentialStore: new FakeCredentialStore(),
      gateway: new FakeGateway(),
      browserLauncher: launcher,
      openBrowser: false,
      writeAuth: () => undefined,
    });
    await handlers.authLogin({}, {});
    expect(launcher.opened).toEqual([]);
  });

  it("reports the device authorization before attempting the launch", async () => {
    const launcher = new FakeBrowserLauncher();
    const events: string[] = [];
    launcher.open = async (url: string) => {
      events.push("launch:" + url);
      return true;
    };
    const handlers = await bootstrap(createConfig({ KESTREL_HOME: dir, GITHUB_CLIENT_ID: "cid" }), {
      credentialStore: new FakeCredentialStore(),
      gateway: new FakeGateway(),
      browserLauncher: launcher,
      openBrowser: true,
      writeAuth: () => undefined,
    });
    await handlers.authLogin(
      {},
      {
        onNotice: (view) => {
          events.push("notice:" + view.kind);
        },
      },
    );
    expect(events).toEqual([
      "notice:device-authorization",
      "launch:https://github.com/login/device",
      "notice:verification",
    ]);
  });

  it("reports the instructions exactly once, never repeating them after a launch", async () => {
    const launcher = new FakeBrowserLauncher();
    const handlers = await bootstrap(createConfig({ KESTREL_HOME: dir, GITHUB_CLIENT_ID: "cid" }), {
      credentialStore: new FakeCredentialStore(),
      gateway: new FakeGateway(),
      browserLauncher: launcher,
      openBrowser: true,
      writeAuth: () => undefined,
    });
    const kinds: string[] = [];
    await handlers.authLogin(
      {},
      {
        onNotice: (view) => {
          kinds.push(view.kind);
        },
      },
    );
    expect(kinds.filter((kind) => kind === "device-authorization")).toHaveLength(1);
  });

  it("claims nothing about a browser when the launch fails", async () => {
    const launcher = new FakeBrowserLauncher();
    launcher.result = false;
    const kinds: string[] = [];
    const handlers = await bootstrap(createConfig({ KESTREL_HOME: dir, GITHUB_CLIENT_ID: "cid" }), {
      credentialStore: new FakeCredentialStore(),
      gateway: new FakeGateway(),
      browserLauncher: launcher,
      openBrowser: true,
      writeAuth: () => undefined,
    });
    const view = await handlers.authLogin(
      {},
      {
        onNotice: (notice) => {
          kinds.push(notice.kind);
        },
      },
    );
    expect(kinds).toEqual(["device-authorization"]);
    expect(view.kind).toBe("auth-status");
  });

  it("authLogin fails without starting device flow in a non-interactive session", async () => {
    const gateway = new FakeGateway();
    const handlers = await bootstrap(createConfig({ KESTREL_HOME: dir, GITHUB_CLIENT_ID: "cid" }), {
      interactive: false,
      credentialStore: new FakeCredentialStore(),
      gateway,
    });
    await expect(handlers.authLogin({}, {})).rejects.toMatchObject({
      code: "DM_GITHUB_AUTH_REQUIRED",
    });
    expect(gateway.deviceFlowCalls).toBe(0);
  });

  it("authLogout refuses without a confirmation and deletes nothing", async () => {
    const store = new FakeCredentialStore();
    store.credential = { service: "github", account: "octocat", token: "cached-token" };
    const handlers = await bootstrap(createConfig({ KESTREL_HOME: dir }), {
      credentialStore: store,
      gateway: new FakeGateway(),
    });
    await expect(handlers.authLogout({}, {})).rejects.toMatchObject({ category: "INVALID_INPUT" });
    expect(store.deleted).toEqual([]);
  });

  it("authLogout clears the credential when confirmed", async () => {
    const store = new FakeCredentialStore();
    store.credential = { service: "github", account: "octocat", token: "cached-token" };
    const handlers = await bootstrap(createConfig({ KESTREL_HOME: dir }), {
      credentialStore: store,
      gateway: new FakeGateway(),
    });
    const view = await handlers.authLogout({ confirmation: "github.com" }, {});
    expect(view).toEqual({
      kind: "auth-status",
      connected: false,
      login: null,
      detail: "LOGGED_OUT",
    });
    expect(store.deleted).toEqual(["octocat"]);
  });

  it("authLogout forwards the per-invocation context signal into the credential lookup", async () => {
    const store = new FakeCredentialStore();
    store.credential = { service: "github", account: "octocat", token: "cached-token" };
    const handlers = await bootstrap(createConfig({ KESTREL_HOME: dir }), {
      credentialStore: store,
      gateway: new FakeGateway(),
    });
    const controller = new AbortController();
    const view = await handlers.authLogout(
      { confirmation: "github.com" },
      { signal: controller.signal },
    );
    expect(view).toEqual({
      kind: "auth-status",
      connected: false,
      login: null,
      detail: "LOGGED_OUT",
    });
    expect(store.deleted).toEqual(["octocat"]);
    // Causal assertion: the controller's signal — not the use case's
    // never-aborted fallback — is what the credential port sees.
    expect(store.getSignals).toEqual([controller.signal]);
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
    description:
      "The application crashes during startup.\n\nReproduce it with the sample configuration.",
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

    const find = await handlers.find({ mood: "QUICK_WIN" }, {});
    expect(find.kind).toBe("recommendation");
    if (find.kind === "recommendation") {
      expect(find.title).toBe("Fix crash on startup");
      expect(find.recommendationId).toBe("challenge-42");
      expect(find.description).toContain("The application crashes during startup.");
      expect(find.repository).toBe("octocat/hello-world");
      expect(find.issueNumber).toBe(42);
      expect(find.issueUrl).toBe("https://github.com/octocat/hello-world/issues/42");
      expect(find.challengeType).toBe("BUG_FIX");
    }

    const accepted = await handlers.missionAccept({ recommendationId: "challenge-42" }, {});
    expect(accepted.kind).toBe("mission");
    if (accepted.kind === "mission") {
      expect(accepted.title).toBe("Fix crash on startup");
    }
    expect(searches()).toBe(1);
  });

  it("continues startup on a corrupt legacy recommendation, reporting to stderr", async () => {
    const { store, gateway } = authDeps();
    const challengeA = makeChallenge(42, "Fix crash on startup");
    const { source } = sequencingSource([challengeA]);
    await writeFile(join(dir, "recommendation.json"), "{ not json", "utf8");
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const handlers = await bootstrap(
        createConfig({ KESTREL_HOME: dir, KESTREL_WORKSPACE: join(dir, "workspace") }),
        { credentialStore: store, gateway, challengeSourceFactory: () => source },
      );
      expect(handlers).toBeDefined();
      const combined = writeSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(combined).toContain("Legacy recommendation");
    } finally {
      writeSpy.mockRestore();
    }
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
      handlers.missionAccept({ recommendationId: "challenge-42" }, {}),
    ).rejects.toMatchObject({ code: "DM_RECOMMENDATION_NOT_FOUND" });

    const first = await handlers.find({ mood: "QUICK_WIN" }, {});
    expect(first.kind).toBe("recommendation");

    // Unknown identifier.
    await expect(
      handlers.missionAccept({ recommendationId: "challenge-unknown" }, {}),
    ).rejects.toMatchObject({ code: "DM_RECOMMENDATION_NOT_FOUND" });

    // Malformed identifier (empty).
    await expect(handlers.missionAccept({ recommendationId: "  " }, {})).rejects.toMatchObject({
      code: "DM_ILLEGAL_TRANSITION",
    });

    // A later find writes an immutable separate snapshot: it never supersedes
    // the first recommendation, so the earlier id stays valid.
    await handlers.find({ mood: "QUICK_WIN" }, {});
    const accepted = await handlers.missionAccept({ recommendationId: "challenge-42" }, {});
    expect(accepted.kind).toBe("mission");
    if (accepted.kind === "mission") {
      expect(accepted.title).toBe("Fix crash on startup");
    }
  });
});
