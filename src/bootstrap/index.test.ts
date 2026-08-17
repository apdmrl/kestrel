import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
