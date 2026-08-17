import type { EvidenceId } from "../domain/evidence/evidence.js";
import type {
  ChallengeId,
  EventId,
  HandoffId,
  MissionId,
  TransactionId,
} from "../domain/shared/identifiers.js";

/** Purpose-specific identifier generation for immutable domain objects. */
export interface IdGenerator {
  newMissionId(): MissionId;
  newChallengeId(): ChallengeId;
  newEventId(): EventId;
  newHandoffId(): HandoffId;
  newTransactionId(): TransactionId;
  newEvidenceId(): EvidenceId;
}
