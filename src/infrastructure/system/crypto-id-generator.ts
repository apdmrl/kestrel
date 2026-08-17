import { randomUUID } from "node:crypto";
import type { EvidenceId } from "../../domain/evidence/evidence.js";
import type {
  ChallengeId,
  EventId,
  HandoffId,
  MissionId,
  TransactionId,
} from "../../domain/shared/identifiers.js";
import type { IdGenerator } from "../../ports/id-generator.js";

export class CryptoIdGenerator implements IdGenerator {
  newMissionId(): MissionId {
    return randomUUID() as MissionId;
  }

  newChallengeId(): ChallengeId {
    return randomUUID() as ChallengeId;
  }

  newEventId(): EventId {
    return randomUUID() as EventId;
  }

  newHandoffId(): HandoffId {
    return randomUUID() as HandoffId;
  }

  newTransactionId(): TransactionId {
    return randomUUID() as TransactionId;
  }

  newEvidenceId(): EvidenceId {
    return randomUUID() as EvidenceId;
  }
}
