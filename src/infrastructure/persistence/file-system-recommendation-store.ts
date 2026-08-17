import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { createKestrelError } from "../../application/errors/kestrel-error.js";
import type { RecommendationSnapshot } from "../../domain/recommendation/recommendation.js";
import type { ChallengeId } from "../../domain/shared/identifiers.js";
import type { RecommendationStore } from "../../ports/recommendation-store.js";
import { readValidatedJson, writeJsonAtomically } from "../fs/atomic-json-file.js";
import {
  fromPersistedRecommendationSnapshot,
  toPersistedRecommendation,
} from "./mappers/mission-mapper.js";
import { recommendationSnapshotSchema } from "./schemas/mission-schema.js";

const storedRecommendationSchema = z.object({
  schemaVersion: z.literal(1),
  recommendationId: z.string().min(1),
  recommendation: recommendationSnapshotSchema,
});

type StoredRecommendationFile = z.infer<typeof storedRecommendationSchema>;

function corruptError() {
  return createKestrelError({
    code: "DM_STATE_CORRUPTED",
    category: "RECOVERABLE_STATE",
    userMessage: "Persisted recommendation is invalid",
    suggestedActions: ["Run find again to discover a fresh recommendation"],
    retryability: "NO_RETRY",
    recoveryStrategy: "USER_ACTION",
    severity: "ERROR",
  });
}

/** Persists the single latest recommendation as a JSON file. */
export class FileSystemRecommendationStore implements RecommendationStore {
  constructor(private readonly filePath: string) {}

  async save(recommendation: RecommendationSnapshot): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const envelope: StoredRecommendationFile = {
      schemaVersion: 1,
      recommendationId: recommendation.challenge.id,
      recommendation: toPersistedRecommendation(recommendation),
    };
    await writeJsonAtomically(this.filePath, envelope, storedRecommendationSchema);
  }

  async loadLatest(): Promise<RecommendationSnapshot | undefined> {
    const envelope = await readValidatedJson(this.filePath, storedRecommendationSchema);
    if (envelope === undefined) {
      return undefined;
    }
    return this.reconstruct(envelope.recommendation);
  }

  async load(challengeId: ChallengeId): Promise<RecommendationSnapshot | undefined> {
    const envelope = await readValidatedJson(this.filePath, storedRecommendationSchema);
    if (envelope === undefined || envelope.recommendationId !== challengeId) {
      return undefined;
    }
    return this.reconstruct(envelope.recommendation);
  }

  private reconstruct(
    recommendation: StoredRecommendationFile["recommendation"],
  ): RecommendationSnapshot {
    const result = fromPersistedRecommendationSnapshot(recommendation);
    if (!result.ok) {
      throw corruptError();
    }
    return result.value;
  }
}
