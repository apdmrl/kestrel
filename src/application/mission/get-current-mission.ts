import { resolve, sep } from "node:path";
import type { Mission } from "../../domain/mission/mission.js";
import type { MissionId } from "../../domain/shared/identifiers.js";
import type { MissionIndexEntry, MissionIndexStore } from "../../ports/mission-index-store.js";
import type { MissionStore } from "../../ports/mission-store.js";

export interface GetCurrentMissionDeps {
  readonly missionIndexStore: MissionIndexStore;
  readonly missionStore: MissionStore;
}

export interface GetCurrentMissionInput {
  readonly missionId?: MissionId;
  readonly cwd?: string;
}

export type GetCurrentMissionResult =
  | { readonly kind: "mission"; readonly mission: Mission }
  | { readonly kind: "none" }
  | { readonly kind: "ambiguous"; readonly missionIds: readonly MissionId[] };

const ACTIVE = new Set(["ACCEPTED", "PREPARING", "IN_PROGRESS"]);

function isActive(entry: MissionIndexEntry): boolean {
  return ACTIVE.has(entry.status);
}

function repoPathFromSidecar(sidecarPath: string): string {
  return resolve(sidecarPath, "..", "repo");
}

function isPathWithin(cwd: string, dir: string): boolean {
  const resolvedCwd = resolve(cwd);
  const resolvedDir = resolve(dir);
  return resolvedCwd === resolvedDir || resolvedCwd.startsWith(resolvedDir + sep);
}

async function loadMission(
  deps: GetCurrentMissionDeps,
  entry: MissionIndexEntry,
): Promise<GetCurrentMissionResult> {
  const stored = await deps.missionStore.get(entry.sidecarPath);
  if (stored === undefined) {
    return { kind: "none" };
  }
  return { kind: "mission", mission: stored.mission };
}

/** Resolve the current mission without acquiring a mutation lock. */
export async function getCurrentMission(
  deps: GetCurrentMissionDeps,
  input: GetCurrentMissionInput,
): Promise<GetCurrentMissionResult> {
  const stored = await deps.missionIndexStore.get();
  const entries = stored.index.entries;

  if (input.missionId !== undefined) {
    const entry = entries.find((candidate) => candidate.missionId === input.missionId);
    if (entry === undefined) {
      return { kind: "none" };
    }
    return loadMission(deps, entry);
  }

  if (input.cwd !== undefined) {
    const entry = entries.find((candidate) =>
      isPathWithin(input.cwd as string, repoPathFromSidecar(candidate.sidecarPath)),
    );
    if (entry === undefined) {
      return { kind: "none" };
    }
    return loadMission(deps, entry);
  }

  const active = entries.filter(isActive);
  if (active.length === 0) {
    return { kind: "none" };
  }
  if (active.length === 1) {
    const entry = active[0];
    if (entry === undefined) {
      return { kind: "none" };
    }
    return loadMission(deps, entry);
  }
  return { kind: "ambiguous", missionIds: active.map((entry) => entry.missionId) };
}
