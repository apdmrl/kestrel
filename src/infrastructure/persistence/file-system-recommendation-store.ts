import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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
function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT"
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A uniquely owned staging name derived from the legacy pathname. */
function stagingNameFor(legacyPath: string): string {
  return legacyPath + "." + randomUUID() + ".staging";
}

/** Match only staging files that belong to this exact legacy pathname. */
function stagingPatternFor(legacyPath: string): RegExp {
  return new RegExp("^" + escapeRegExp(basename(legacyPath)) + "\\.(.*)\\.staging$");
}

export interface MigrationHooks {
  /** Test seam fired immediately after the legacy file is claimed (renamed). */
  readonly afterClaim?: (stagingPath: string) => Promise<void> | void;
}

/**
 * Migrate a single owned staging file: parse, validate, install per-id, and
 * delete ONLY that staging file once the snapshot is durably confirmed.
 * On failure the staging evidence is preserved (and, when a restore target is
 * supplied and the legacy pathname is still absent, safely restored).
 */
async function processStagingFile(
  stagingPath: string,
  store: RecommendationStore,
  onDiagnostic: (message: string) => void,
  restoreTo?: string,
): Promise<boolean> {
  let envelope;
  try {
    envelope = await readValidatedJson(stagingPath, storedRecommendationSchema);
  } catch {
    // Corrupt staging was already backed up by the reader (evidence preserved).
    onDiagnostic("Legacy recommendation was corrupt and was left in place; run find to refresh.");
    return false;
  }
  if (envelope === undefined) {
    return false;
  }
  const result = fromPersistedRecommendationSnapshot(envelope.recommendation);
  if (!result.ok || envelope.recommendationId !== result.value.challenge.id) {
    onDiagnostic("Legacy recommendation was inconsistent and was left in place for manual review.");
    await restoreOrPreserve(stagingPath, restoreTo, onDiagnostic);
    return false;
  }
  try {
    await store.save(result.value);
  } catch {
    onDiagnostic("Legacy recommendation could not be migrated and was left in place.");
    await restoreOrPreserve(stagingPath, restoreTo, onDiagnostic);
    return false;
  }
  // The identical snapshot is now durably confirmed installed; remove ONLY this
  // owned staging file. A concurrently recreated recommendation.json is never
  // touched here.
  await rm(stagingPath);
  return true;
}

/** Restore the staging file to the legacy pathname if it is still absent. */
async function restoreOrPreserve(
  stagingPath: string,
  restoreTo: string | undefined,
  onDiagnostic: (message: string) => void,
): Promise<void> {
  if (restoreTo === undefined) {
    return; // orphan recovery: leave the staging file as evidence.
  }
  let legacyExists = true;
  try {
    await lstat(restoreTo);
  } catch (error) {
    if (isEnoent(error)) {
      legacyExists = false;
    }
  }
  if (legacyExists) {
    // An older writer recreated recommendation.json: never overwrite it; keep
    // the claimed evidence in the staging file.
    onDiagnostic(
      "A newer legacy recommendation appeared during migration; migrated evidence is preserved in a staging file.",
    );
    return;
  }
  await rename(stagingPath, restoreTo).catch(() => {
    onDiagnostic("Could not restore the legacy recommendation file after a failed migration.");
  });
}

/**
 * Migrate the legacy single-latest recommendation file (used before the per-id
 * `recommendations/` layout) into the per-id store. Returns true when a legacy
 * snapshot was validated, installed identically, and consumed.
 *
 * The migration is serialized against concurrent writers and other migrators by
 * an atomic claim: the legacy pathname is first RENAMED to a uniquely owned
 * staging name, and the original pathname is never deleted directly. The owned
 * staging file is removed only after an identical snapshot is durably confirmed
 * installed. On any failure the claimed evidence is preserved (restored to the
 * legacy pathname when it is still absent) and a safe stderr diagnostic is
 * emitted, so evidence is never destroyed and a concurrently recreated
 * `recommendation.json` is never deleted. Any orphaned staging file left by a
 * previously crashed migration is recovered idempotently on the next call.
 */
export async function migrateLegacyRecommendation(
  legacyPath: string,
  store: RecommendationStore,
  onDiagnostic: (message: string) => void = () => undefined,
  hooks: MigrationHooks = {},
): Promise<boolean> {
  // 1. Recover any orphaned staging file from a previously crashed migration.
  let recovered = false;
  const parent = dirname(legacyPath);
  const pattern = stagingPatternFor(legacyPath);
  for (const entry of await readdir(parent).catch(() => [])) {
    if (!pattern.test(entry)) {
      continue;
    }
    const stagingPath = join(parent, entry);
    if (await processStagingFile(stagingPath, store, onDiagnostic)) {
      recovered = true;
    }
  }

  // 2. Claim the live legacy file atomically, or stop if none is present.
  const stagingPath = stagingNameFor(legacyPath);
  try {
    await rename(legacyPath, stagingPath);
  } catch (error) {
    if (isEnoent(error)) {
      return recovered;
    }
    onDiagnostic("Legacy recommendation could not be claimed for migration.");
    return recovered;
  }
  if (hooks.afterClaim !== undefined) {
    await hooks.afterClaim(stagingPath);
  }
  const migrated = await processStagingFile(stagingPath, store, onDiagnostic, legacyPath);
  return migrated || recovered;
}
