import type { ChallengeId, EventId, HandoffId, MissionId } from "../domain/shared/identifiers.js";

/** Purpose-specific identifier generation for immutable domain objects. */
export interface IdGenerator {
  newMissionId(): MissionId;
  newChallengeId(): ChallengeId;
  newEventId(): EventId;
  newHandoffId(): HandoffId;
}
