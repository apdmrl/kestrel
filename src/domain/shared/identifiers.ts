import type { Brand } from "./brand.js";
import type { DomainResult } from "./result.js";
import { err, ok } from "./result.js";

export type MissionId = Brand<string, "MissionId">;
export type ChallengeId = Brand<string, "ChallengeId">;
export type EventId = Brand<string, "EventId">;
export type HandoffId = Brand<string, "HandoffId">;

function parseId<T extends string>(brand: T, input: string): DomainResult<Brand<string, T>> {
  const value = input.trim();
  if (value.length === 0) {
    return err("DM_INVALID_ID", "Identifier must not be empty");
  }
  return ok(value as Brand<string, T>);
}

export function parseMissionId(input: string): DomainResult<MissionId> {
  return parseId("MissionId", input);
}

export function parseChallengeId(input: string): DomainResult<ChallengeId> {
  return parseId("ChallengeId", input);
}

export function parseEventId(input: string): DomainResult<EventId> {
  return parseId("EventId", input);
}

export function parseHandoffId(input: string): DomainResult<HandoffId> {
  return parseId("HandoffId", input);
}
