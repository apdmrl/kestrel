import { z } from "zod";
import {
  evidenceSchema,
  isoDateTimeSchema,
  issueLinkEvidenceSchema,
  mergeEvidenceSchema,
  pullRequestEvidenceSchema,
  repositoryIdentitySchema,
} from "./evidence-schema.js";

const challengeSourceReferenceSchema = z.object({
  provider: z.literal("github"),
  externalId: z.string(),
  repository: repositoryIdentitySchema,
  issueNumber: z.number().int().min(1),
  canonicalUrl: z.string(),
});

const challengeSchema = z.object({
  id: z.string().min(1),
  source: challengeSourceReferenceSchema,
  repository: repositoryIdentitySchema,
  title: z.string().min(1),
  description: z.string(),
  type: z.enum(["BUG_FIX", "TESTING", "DOCUMENTATION"]),
  labels: z.array(z.string()),
  language: z.string().nullable(),
  topics: z.array(z.string()),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

const signalResultSchema = z.object({
  name: z.string().min(1),
  value: z.number(),
  confidence: z.number(),
  reason: z.string().min(1),
});

const recommendationSnapshotSchema = z.object({
  challenge: challengeSchema,
  mood: z.enum([
    "QUICK_WIN",
    "DEEP_DEBUGGING",
    "LEARN_SOMETHING_NEW",
    "HARD_CHALLENGE",
    "SURPRISE_ME",
  ]),
  reasons: z.array(z.string()),
  signalResults: z.array(signalResultSchema),
  confidence: z.number(),
  evaluatedAt: isoDateTimeSchema,
});

const acceptanceContextSchema = z.object({
  mode: z.enum(["GUIDED", "EXPERT"]),
  workspaceRoot: z.string().nullable(),
  acceptedAt: isoDateTimeSchema,
});

const workspaceInfoSchema = z.object({
  root: z.string().min(1),
  missionDirectory: z.string().min(1),
  repositoryPath: z.string().min(1),
  sidecarPath: z.string().min(1),
});

const evidenceCollectionSchema = z.object({
  items: z.array(evidenceSchema),
});

export const missionSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  challengeSnapshot: challengeSchema,
  recommendationSnapshot: recommendationSnapshotSchema,
  acceptanceContext: acceptanceContextSchema,
  status: z.enum(["ACCEPTED", "PREPARING", "IN_PROGRESS", "COMPLETED", "ABANDONED"]),
  workspace: workspaceInfoSchema.nullable(),
  immutableBaseCommit: z.string().nullable(),
  branch: z.string().nullable(),
  evidence: evidenceCollectionSchema,
  submissionVerification: z.enum(["NONE", "SUBMITTED", "MERGED"]),
  submittedPullRequest: pullRequestEvidenceSchema.nullable(),
  mergeEvidence: mergeEvidenceSchema.nullable(),
  issueLink: issueLinkEvidenceSchema.nullable(),
});

export type PersistedMission = z.infer<typeof missionSchema>;
export type PersistedChallenge = z.infer<typeof challengeSchema>;
export type PersistedRecommendationSnapshot = z.infer<typeof recommendationSnapshotSchema>;
