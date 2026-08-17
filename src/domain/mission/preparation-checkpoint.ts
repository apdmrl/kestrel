export type PreparationCheckpoint =
  | "WORKSPACE_CREATED"
  | "REPOSITORY_CLONED"
  | "BASE_RECORDED"
  | "BRANCH_CREATED"
  | "CONTEXT_COLLECTED"
  | "GUIDANCE_GENERATED"
  | "BRIEF_GENERATED";

export const PREPARATION_CHECKPOINTS: readonly PreparationCheckpoint[] = [
  "WORKSPACE_CREATED",
  "REPOSITORY_CLONED",
  "BASE_RECORDED",
  "BRANCH_CREATED",
  "CONTEXT_COLLECTED",
  "GUIDANCE_GENERATED",
  "BRIEF_GENERATED",
];

/** A recorded preparation step plus only the data needed to verify/resume it. */
export interface PreparationCheckpointState {
  readonly checkpoint: PreparationCheckpoint;
  readonly data: Readonly<Record<string, unknown>>;
}

export function checkpointIndex(checkpoint: PreparationCheckpoint): number {
  return PREPARATION_CHECKPOINTS.indexOf(checkpoint);
}
