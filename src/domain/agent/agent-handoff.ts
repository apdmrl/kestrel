import type { AgentBrief } from "./agent-brief.js";
import type { HandoffId, MissionId } from "../shared/identifiers.js";
import type { DomainResult } from "../shared/result.js";
import { err, ok } from "../shared/result.js";
import type { IsoDateTime } from "../shared/time.js";

/** An immutable snapshot of an actual agent handoff. */
export interface AgentHandoff {
  readonly schemaVersion: 1;
  readonly handoffId: HandoffId;
  readonly missionId: MissionId;
  readonly briefSchemaVersion: 1;
  readonly policyVersion: number;
  readonly renderer: string;
  readonly createdAt: IsoDateTime;
  readonly developerHypothesisSnapshot: string | undefined;
  readonly briefSnapshot: AgentBrief;
  readonly renderedPromptHash: string;
}

export interface CreateAgentHandoffInput {
  readonly handoffId: HandoffId;
  readonly missionId: MissionId;
  readonly policyVersion: number;
  readonly renderer: string;
  readonly createdAt: IsoDateTime;
  readonly developerHypothesisSnapshot?: string;
  readonly briefSnapshot: AgentBrief;
  readonly renderedPromptHash: string;
}

const SHA256_HEX = /^[a-f0-9]{64}$/;

export function createAgentHandoff(input: CreateAgentHandoffInput): DomainResult<AgentHandoff> {
  if (input.handoffId.trim().length === 0) {
    return err("DM_INVALID_HANDOFF", "handoff id must not be empty");
  }
  if (!SHA256_HEX.test(input.renderedPromptHash)) {
    return err("DM_INVALID_HANDOFF", "rendered prompt hash must be a 64-character hex string");
  }
  return ok({
    schemaVersion: 1,
    handoffId: input.handoffId,
    missionId: input.missionId,
    briefSchemaVersion: 1,
    policyVersion: input.policyVersion,
    renderer: input.renderer,
    createdAt: input.createdAt,
    developerHypothesisSnapshot: input.developerHypothesisSnapshot,
    briefSnapshot: input.briefSnapshot,
    renderedPromptHash: input.renderedPromptHash,
  });
}
