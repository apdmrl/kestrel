import { z } from "zod";

export const isoDateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/);

export const repositoryIdentitySchema = z.object({
  provider: z.literal("github"),
  owner: z.string().min(1),
  name: z.string().min(1),
});

export const localChangeEvidenceSchema = z.object({
  kind: z.literal("LOCAL_CHANGE"),
  id: z.string().min(1),
  missionId: z.string().min(1),
  provider: z.literal("github"),
  observedAt: isoDateTimeSchema,
  baseCommit: z.string().min(1),
  headCommit: z.string().min(1),
  commitsCreated: z.array(z.string()),
  filesChanged: z.array(z.string()),
  insertions: z.number().int().min(0),
  deletions: z.number().int().min(0),
  workingTreeState: z.enum(["CLEAN", "DIRTY"]),
});

export const commitEvidenceSchema = z.object({
  kind: z.literal("COMMIT"),
  id: z.string().min(1),
  missionId: z.string().min(1),
  provider: z.literal("github"),
  observedAt: isoDateTimeSchema,
  sha: z.string().min(1),
  message: z.string(),
  author: z.string(),
  committedAt: isoDateTimeSchema,
});

export const pullRequestEvidenceSchema = z.object({
  kind: z.literal("PULL_REQUEST"),
  id: z.string().min(1),
  missionId: z.string().min(1),
  provider: z.literal("github"),
  observedAt: isoDateTimeSchema,
  number: z.number().int().min(1),
  url: z.string().min(1),
  repository: repositoryIdentitySchema,
  author: z.string(),
  commits: z.array(z.string()),
  state: z.enum(["OPEN", "MERGED", "CLOSED"]),
});

export const issueLinkEvidenceSchema = z.object({
  kind: z.literal("ISSUE_LINK"),
  id: z.string().min(1),
  missionId: z.string().min(1),
  provider: z.literal("github"),
  observedAt: isoDateTimeSchema,
  issueNumber: z.number().int().min(1),
  repository: repositoryIdentitySchema,
  relationship: z.enum(["CLOSING_KEYWORD", "CROSS_REFERENCE", "PROVIDER_VERIFIED"]),
});

export const mergeEvidenceSchema = z.object({
  kind: z.literal("MERGE"),
  id: z.string().min(1),
  missionId: z.string().min(1),
  provider: z.literal("github"),
  observedAt: isoDateTimeSchema,
  pullRequestNumber: z.number().int().min(1),
  repository: repositoryIdentitySchema,
  mergeSha: z.string().min(1),
  mergedAt: isoDateTimeSchema,
});

export const evidenceSchema = z.discriminatedUnion("kind", [
  localChangeEvidenceSchema,
  commitEvidenceSchema,
  pullRequestEvidenceSchema,
  issueLinkEvidenceSchema,
  mergeEvidenceSchema,
]);

export type PersistedEvidence = z.infer<typeof evidenceSchema>;
export type PersistedPullRequestEvidence = z.infer<typeof pullRequestEvidenceSchema>;
export type PersistedMergeEvidence = z.infer<typeof mergeEvidenceSchema>;
export type PersistedIssueLinkEvidence = z.infer<typeof issueLinkEvidenceSchema>;
