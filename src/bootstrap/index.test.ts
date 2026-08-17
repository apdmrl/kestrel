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
    const config = createConfig({ KESTREL_HOME: "/tmp/home", KESTREL_WORKSPACE: "/tmp/ws" });
    expect(config.home).toBe("/tmp/home");
    expect(config.workspaceRoot).toBe("/tmp/ws");
  });

  it("returns an empty journey without credentials", async () => {
    const handlers = await bootstrap(createConfig({ KESTREL_HOME: dir }));
    const view = await handlers.journey();
    expect(view.kind).toBe("progress");
    if (view.kind === "progress") {
      expect(view.counts.accepted).toBe(0);
    }
  });

  it("resolves no active mission without credentials", async () => {
    const handlers = await bootstrap(createConfig({ KESTREL_HOME: dir }));
    const view = await handlers.missionCurrent();
    expect(view.kind).toBe("verification");
  });
});
