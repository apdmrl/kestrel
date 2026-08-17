import { randomUUID } from "node:crypto";
import type {
  ChallengeId,
  EventId,
  HandoffId,
  MissionId,
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
}
