/** A policy's verdict on whether minimum local evidence is satisfied. */
export interface EvidenceDecision {
  readonly accepted: boolean;
  readonly blockingReasons: readonly string[];
  readonly warnings: readonly string[];
}

export function acceptEvidence(warnings: readonly string[] = []): EvidenceDecision {
  return { accepted: true, blockingReasons: [], warnings };
}

export function blockEvidence(blockingReasons: readonly string[]): EvidenceDecision {
  return { accepted: false, blockingReasons, warnings: [] };
}
