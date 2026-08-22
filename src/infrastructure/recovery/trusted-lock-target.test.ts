import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyTrustedLockTarget, type PathCanonicalizer } from "./trusted-lock-target.js";
import type { MissionId } from "../../domain/shared/identifiers.js";

const MISSION_ID = "m-1" as MissionId;

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kestrel-trust-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("verifyTrustedLockTarget", () => {
  it("accepts a valid sidecar inside the managed workspace and derives its lock path", async () => {
    const root = await tempDir();
    const sidecar = join(root, "mission-abc", "kestrel");
    await mkdir(sidecar, { recursive: true });
    await writeFile(join(sidecar, "mission.json"), '{"mission":{"id":"m-1"}}', "utf8");
    const result = await verifyTrustedLockTarget({
      workspaceRoot: root,
      missionId: MISSION_ID,
      sidecarPath: sidecar,
    });
    expect(result.lockPath).toBe(join(sidecar, ".lock"));
    expect(result.sidecarPath).toBe(sidecar);
  });

  it("rejects a sidecar path outside the managed workspace", async () => {
    const root = await tempDir();
    const outside = await tempDir();
    const sidecar = join(outside, "kestrel");
    await mkdir(sidecar, { recursive: true });
    await expect(
      verifyTrustedLockTarget({ workspaceRoot: root, missionId: MISSION_ID, sidecarPath: sidecar }),
    ).rejects.toMatchObject({ code: "DM_UNSAFE_PATH" });
  });

  it("rejects a traversal (..) sidecar path that escapes the workspace", async () => {
    const root = await tempDir();
    const escape = join(root, "..", "escape-" + Math.random(), "kestrel");
    await mkdir(escape, { recursive: true });
    await expect(
      verifyTrustedLockTarget({ workspaceRoot: root, missionId: MISSION_ID, sidecarPath: escape }),
    ).rejects.toMatchObject({ code: "DM_UNSAFE_PATH" });
  });

  it("rejects a symlink component that redirects to another directory", async () => {
    const root = await tempDir();
    const real = await tempDir();
    const sidecar = join(real, "kestrel");
    await mkdir(sidecar, { recursive: true });
    const link = join(root, "mission-link");
    await symlink(real, link);
    await expect(
      verifyTrustedLockTarget({
        workspaceRoot: root,
        missionId: MISSION_ID,
        sidecarPath: join(link, "kestrel"),
      }),
    ).rejects.toMatchObject({ code: "DM_UNSAFE_PATH" });
  });

  it("rejects a path that is lexically inside but canonically outside the workspace", async () => {
    const root = await tempDir();
    const outside = await tempDir();
    const outSidecar = join(outside, "kestrel");
    await mkdir(outSidecar, { recursive: true });
    // A symlink inside the root that resolves outside the root.
    const link = join(root, "inside-link");
    await symlink(outSidecar, link);
    await expect(
      verifyTrustedLockTarget({ workspaceRoot: root, missionId: MISSION_ID, sidecarPath: link }),
    ).rejects.toMatchObject({ code: "DM_UNSAFE_PATH" });
  });

  it("keeps a valid stale and a valid live lock reachable at the intended mission path", async () => {
    const root = await tempDir();
    const sidecar = join(root, "mission-abc", "kestrel");
    await mkdir(sidecar, { recursive: true });
    const result = await verifyTrustedLockTarget({
      workspaceRoot: root,
      missionId: MISSION_ID,
      sidecarPath: sidecar,
    });
    // The derived lock path is exactly the intended `.lock` under the sidecar.
    expect(result.lockPath).toBe(join(sidecar, ".lock"));
  });

  describe("canonical root-alias agreement (macOS /var vs /private/var)", () => {
    // Deterministic model of macOS temporary paths: `/var/...` is a symlink
    // alias of `/private/var/...`. Both lexical forms are the SAME canonical
    // root and must agree. No macOS filesystem is required.
    const varToPrivateVar: PathCanonicalizer = async (p) => p.replace(/^\/var\//, "/private/var/");

    it("accepts two lexical aliases that resolve to one canonical root", async () => {
      // The alias mapping below is a POSIX path model (/var vs /private/var);
      // the real-symlink test covers the same property cross-platform.
      if (process.platform === "win32") {
        return;
      }
      const result = await verifyTrustedLockTarget({
        workspaceRoot: "/var/kestrel-ws",
        missionId: MISSION_ID,
        sidecarPath: "/private/var/kestrel-ws/mission-abc/kestrel",
        canonicalize: varToPrivateVar,
      });
      expect(result.sidecarPath).toBe("/private/var/kestrel-ws/mission-abc/kestrel");
      expect(result.lockPath).toBe("/private/var/kestrel-ws/mission-abc/kestrel/.lock");
    });

    it("rejects a genuinely different canonical root despite a shared alias", async () => {
      if (process.platform === "win32") {
        return;
      }
      await expect(
        verifyTrustedLockTarget({
          workspaceRoot: "/var/ws-a",
          missionId: MISSION_ID,
          sidecarPath: "/other/ws-b/mission/kestrel",
          canonicalize: varToPrivateVar,
        }),
      ).rejects.toMatchObject({ code: "DM_UNSAFE_PATH" });
    });

    it("accepts a sidecar reached through a real symlinked workspace alias of one root", async () => {
      const real = await tempDir();
      const alias = await tempDir();
      await rm(alias, { recursive: true, force: true });
      await symlink(real, alias); // alias -> real, like /var -> /private/var
      const sidecar = join(real, "mission-abc", "kestrel");
      await mkdir(sidecar, { recursive: true });
      // workspaceRoot is the alias (raw) form; sidecar is the canonical form.
      const result = await verifyTrustedLockTarget({
        workspaceRoot: alias,
        missionId: MISSION_ID,
        sidecarPath: sidecar,
      });
      expect(result.sidecarPath).toBe(sidecar);
      expect(result.lockPath).toBe(join(sidecar, ".lock"));
    });

    it("still rejects a raw symlink component even under one canonical root", async () => {
      const real = await tempDir();
      const root = await tempDir();
      const sidecarReal = join(real, "kestrel");
      await mkdir(sidecarReal, { recursive: true });
      const link = join(root, "mission-link");
      await symlink(real, link);
      await expect(
        verifyTrustedLockTarget({
          workspaceRoot: root,
          missionId: MISSION_ID,
          sidecarPath: join(link, "kestrel"),
          canonicalize: varToPrivateVar,
        }),
      ).rejects.toMatchObject({ code: "DM_UNSAFE_PATH" });
    });
  });
});
