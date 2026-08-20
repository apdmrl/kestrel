import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
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

/** File names are derived from recommendation ids; only portable-safe names pass. */
const SAFE_FILENAME = /^[A-Za-z0-9._-]+$/;

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

function conflictError() {
  return createKestrelError({
    code: "DM_STORE_CONFLICT",
    category: "CONFLICT",
    userMessage: "A different recommendation was already stored under this id",
    suggestedActions: ["Run find to discover a fresh recommendation and use its id"],
    retryability: "NO_RETRY",
    recoveryStrategy: "USER_ACTION",
    severity: "ERROR",
  });
}

function unsafeIdError() {
  return createKestrelError({
    code: "DM_ILLEGAL_TRANSITION",
    category: "INVALID_INPUT",
    userMessage: "Recommendation identifier is not a safe file name",
    suggestedActions: ["Use the recommendation id shown by kestrel find"],
    retryability: "NO_RETRY",
    recoveryStrategy: "USER_ACTION",
    severity: "WARNING",
  });
}

/**
 * Persists immutable, per-id recommendation snapshots under a contained
 * directory. Each snapshot lives in its own file named by the recommendation
 * (challenge) id, written atomically and schema-validated. A later find writes
 * a different file, so it can never replace or shadow a snapshot another
 * terminal is looking at. Duplicate saves of an identical snapshot are
 * idempotent; conflicting content for the same id is rejected.
 */
export class FileSystemRecommendationStore implements RecommendationStore {
  constructor(private readonly directory: string) {}

  async save(recommendation: RecommendationSnapshot): Promise<void> {
    const challengeId = recommendation.challenge.id;
    const filePath = this.filePathFor(challengeId);
    await mkdir(this.directory, { recursive: true });

    const existing = await readValidatedJson(filePath, storedRecommendationSchema);
    if (existing !== undefined) {
      if (existing.recommendationId !== challengeId) {
        throw corruptError();
      }
      if (
        JSON.stringify(existing.recommendation) ===
        JSON.stringify(toPersistedRecommendation(recommendation))
      ) {
        return; // Idempotent: the identical snapshot is already installed.
      }
      throw conflictError();
    }

    const envelope: StoredRecommendationFile = {
      schemaVersion: 1,
      recommendationId: challengeId,
      recommendation: toPersistedRecommendation(recommendation),
    };
    await writeJsonAtomically(filePath, envelope, storedRecommendationSchema);
  }

  async load(challengeId: ChallengeId): Promise<RecommendationSnapshot | undefined> {
    const filePath = this.filePathFor(challengeId);
    const envelope = await readValidatedJson(filePath, storedRecommendationSchema);
    if (envelope === undefined) {
      return undefined;
    }
    if (envelope.recommendationId !== challengeId) {
      throw corruptError();
    }
    return this.reconstruct(envelope.recommendation);
  }

  private filePathFor(challengeId: ChallengeId): string {
    if (!SAFE_FILENAME.test(challengeId)) {
      throw unsafeIdError();
    }
    return join(this.directory, challengeId + ".json");
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

/**
 * Migrate the legacy single-latest recommendation file (used before the per-id
 * `recommendations/` layout) into the per-id store. Returns true when a legacy
 * snapshot was validated, installed identically, and consumed.
 *
 * The legacy file is removed ONLY after an identical snapshot is confirmed
 * installed. It is preserved on any inconsistency (a mismatched envelope id vs
 * snapshot challenge id, unreconstructable content, a conflicting per-id record,
 * or a write failure) so no evidence is ever destroyed by migration. A corrupt
 * file is already backed up by the reader. The `onDiagnostic` callback (defaults
 * to a no-op) receives a safe message for presentation on stderr.
 */
export async function migrateLegacyRecommendation(
  legacyPath: string,
  store: RecommendationStore,
  onDiagnostic: (message: string) => void = () => undefined,
): Promise<boolean> {
  let envelope;
  try {
    envelope = await readValidatedJson(legacyPath, storedRecommendationSchema);
  } catch {
    onDiagnostic("Legacy recommendation was corrupt and was left in place; run find to refresh.");
    return false;
  }
  if (envelope === undefined) {
    return false;
  }
  const result = fromPersistedRecommendationSnapshot(envelope.recommendation);
  if (!result.ok || envelope.recommendationId !== result.value.challenge.id) {
    onDiagnostic("Legacy recommendation was inconsistent and was left in place for manual review.");
    return false;
  }
  try {
    await store.save(result.value);
  } catch {
    onDiagnostic("Legacy recommendation could not be migrated and was left in place.");
    return false;
  }
  // The identical snapshot is now confirmed installed; consume the legacy file.
  await rm(legacyPath);
  return true;
}
