import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { createKestrelError } from "../../application/errors/kestrel-error.js";
import type { Mission } from "../../domain/mission/mission.js";
import type { MissionStore, StoredMission } from "../../ports/mission-store.js";
import { readValidatedJson, writeJsonAtomically } from "../fs/atomic-json-file.js";
import { fromPersistedMission, toPersistedMission } from "./mappers/mission-mapper.js";
import { missionSchema } from "./schemas/mission-schema.js";

const storedMissionSchema = z.object({
  schemaVersion: z.literal(1),
  stateVersion: z.number().int().min(0),
  mission: missionSchema,
});

type StoredMissionFile = z.infer<typeof storedMissionSchema>;

function conflictError() {
  return createKestrelError({
    code: "DM_STORE_CONFLICT",
    category: "CONFLICT",
    userMessage: "Mission state changed since it was read",
    suggestedActions: ["Reload the mission and retry the operation"],
    retryability: "NO_RETRY",
    recoveryStrategy: "USER_ACTION",
    severity: "ERROR",
  });
}

export class FileSystemMissionStore implements MissionStore {
  constructor(private readonly fileName = "mission.json") {}

  private pathFor(sidecarPath: string): string {
    return join(sidecarPath, this.fileName);
  }

  async get(sidecarPath: string): Promise<StoredMission | undefined> {
    const envelope = await readValidatedJson(this.pathFor(sidecarPath), storedMissionSchema);
    if (envelope === undefined) {
      return undefined;
    }
    const mission = fromPersistedMission(envelope.mission);
    if (!mission.ok) {
      throw createKestrelError({
        code: "DM_STATE_CORRUPTED",
        category: "RECOVERABLE_STATE",
        userMessage: "Persisted mission state is invalid",
        suggestedActions: ["Restore from the automatic backup, or remove the corrupt file"],
        retryability: "NO_RETRY",
        recoveryStrategy: "MANUAL_INTERVENTION",
        severity: "ERROR",
        cause: mission.error,
      });
    }
    return { mission: mission.value, version: envelope.stateVersion };
  }

  async save(
    sidecarPath: string,
    mission: Mission,
    expectedVersion: number,
  ): Promise<StoredMission> {
    const path = this.pathFor(sidecarPath);
    await mkdir(dirname(path), { recursive: true });
    const current = await readValidatedJson(path, storedMissionSchema);
    const currentVersion = current?.stateVersion ?? 0;
    if (currentVersion !== expectedVersion) {
      throw conflictError();
    }
    const envelope: StoredMissionFile = {
      schemaVersion: 1,
      stateVersion: expectedVersion + 1,
      mission: toPersistedMission(mission),
    };
    await writeJsonAtomically(path, envelope, storedMissionSchema);
    return { mission, version: expectedVersion + 1 };
  }
}
