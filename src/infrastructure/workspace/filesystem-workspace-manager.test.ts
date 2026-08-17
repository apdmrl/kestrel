import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MissionId } from "../../domain/shared/identifiers.js";
import type { RepositoryIdentity } from "../../domain/challenge/repository-identity.js";
import { FilesystemWorkspaceManager } from "./filesystem-workspace-manager.js";

const manager = new FilesystemWorkspaceManager();
const missionId = "abc-123-def" as MissionId;
const repository: RepositoryIdentity = {
  provider: "github",
  owner: "octocat",
  name: "hello-world",
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kestrel-ws-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("FilesystemWorkspaceManager", () => {
  it("plans a sibling repo/ and kestrel/ layout with a slugged branch", () => {
    const plan = manager.planWorkspace(dir, missionId, repository, 42);
    expect(plan.missionDirectory).toBe(join(dir, "abc-123-def-hello-world-42"));
    expect(plan.repositoryPath).toBe(join(dir, "abc-123-def-hello-world-42", "repo"));
    expect(plan.sidecarPath).toBe(join(dir, "abc-123-def-hello-world-42", "kestrel"));
    expect(plan.branchName).toBe("kestrel/42-hello-world");
  });

  it("slugifies untrusted repository and title text", () => {
    const plan = manager.planWorkspace(
      dir,
      missionId,
      { provider: "github", owner: "../evil", name: "My Repo!!" },
      1,
    );
    expect(plan.missionDirectory).not.toContain("..");
    expect(plan.missionDirectory.startsWith(dir)).toBe(true);
    expect(plan.branchName).toBe("kestrel/1-my-repo");
  });

  it("rejects a relative workspace root before resolving", () => {
    expect(() => manager.planWorkspace("relative-root", missionId, repository, 42)).toThrow();
    expect(() =>
      manager.assertSafePath({
        root: "relative-root",
        missionDirectory: "relative-root/m",
        repositoryPath: "relative-root/m/repo",
        sidecarPath: "relative-root/m/kestrel",
        branchName: "kestrel/42-hello-world",
      }),
    ).toThrow();
  });

  it("rejects a symlink in an intermediate mission component", async () => {
    const outside = await mkdtemp(join(tmpdir(), "kestrel-outside-"));
    await symlink(outside, join(dir, "mission-link"));
    const plan = {
      root: dir,
      missionDirectory: join(dir, "mission-link", "mission"),
      repositoryPath: join(dir, "mission-link", "mission", "repo"),
      sidecarPath: join(dir, "mission-link", "mission", "kestrel"),
      branchName: "kestrel/42-hello-world",
    };
    await expect(manager.createSidecar(plan)).rejects.toMatchObject({ code: "DM_UNSAFE_PATH" });
    await rm(outside, { recursive: true, force: true });
  });

  it("verifies the sidecar real path stays inside the workspace root", async () => {
    const plan = manager.planWorkspace(dir, missionId, repository, 42);
    await manager.createSidecar(plan);
    const { realpath } = await import("node:fs/promises");
    const rootReal = await realpath(dir);
    const sidecarReal = await realpath(plan.sidecarPath);
    expect(sidecarReal.startsWith(rootReal + sep)).toBe(true);
    expect(sidecarReal.startsWith(plan.repositoryPath + sep)).toBe(false);
  });

  it("rejects path traversal outside the root", () => {
    const plan = manager.planWorkspace(dir, missionId, repository, 42);
    const bad = { ...plan, sidecarPath: join(dir, "..", "escaped", "kestrel") };
    expect(() => manager.assertSafePath(bad)).toThrow();
  });

  it("rejects a symlink escape from the mission directory", async () => {
    const plan = manager.planWorkspace(dir, missionId, repository, 42);
    const outside = await mkdtemp(join(tmpdir(), "kestrel-outside-"));
    await symlink(outside, plan.missionDirectory);
    await expect(manager.createSidecar(plan)).rejects.toMatchObject({ code: "DM_UNSAFE_PATH" });
    await rm(outside, { recursive: true, force: true });
  });

  it("creates the sidecar idempotently and leaves unrelated content alone", async () => {
    const plan = manager.planWorkspace(dir, missionId, repository, 42);
    await mkdir(plan.missionDirectory, { recursive: true });
    await writeFile(join(plan.missionDirectory, "unrelated.txt"), "keep me", "utf8");

    await manager.createSidecar(plan);
    await manager.createSidecar(plan);

    expect(plan.sidecarPath).toBe(join(plan.missionDirectory, "kestrel"));
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(join(plan.missionDirectory, "unrelated.txt"), "utf8")).toBe("keep me");
  });

  it("keeps metadata paths outside the repository path", () => {
    const plan = manager.planWorkspace(dir, missionId, repository, 42);
    expect(plan.sidecarPath.startsWith(plan.repositoryPath)).toBe(false);
    expect(plan.repositoryPath.startsWith(plan.sidecarPath)).toBe(false);
  });
});
