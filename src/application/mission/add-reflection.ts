import { createJourneyEvent } from "../../domain/journey/journey-event.js";
import type { Mission } from "../../domain/mission/mission.js";
import { createReflection } from "../../domain/reflection/reflection.js";
import type { CreateReflectionInput } from "../../domain/reflection/reflection.js";
import type { Clock } from "../../ports/clock.js";
import type { IdGenerator } from "../../ports/id-generator.js";
import type { JourneyStore } from "../../ports/journey-store.js";
import type { MissionIndexStore } from "../../ports/mission-index-store.js";
import type { MissionLock } from "../../ports/mission-lock.js";
import type { MissionStore } from "../../ports/mission-store.js";
import type { TransactionJournal } from "../../ports/transaction-journal.js";
import { createKestrelError } from "../errors/kestrel-error.js";
import { commitMissionChange } from "../transactions/commit-mission-change.js";

export interface AddReflectionDeps {
  readonly lock: MissionLock;
  readonly journal: TransactionJournal;
  readonly missionStore: MissionStore;
  readonly journeyStore: JourneyStore;
  readonly indexStore: MissionIndexStore;
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
}

export interface AddReflectionInput {
  readonly mission: Mission;
  readonly sidecarPath: string;
  readonly lockPath: string;
  readonly expectedStateVersion: number;
  readonly reflection: CreateReflectionInput;
  readonly signal?: AbortSignal;
}

/** Record an immutable reflection snapshot without blocking completion. */
export async function addReflection(
  deps: AddReflectionDeps,
  input: AddReflectionInput,
): Promise<Mission> {
  const reflection = createReflection(input.reflection);
  if (!reflection.ok) {
    throw createKestrelError({
      code: "DM_INVALID_REFLECTION",
      category: "INVALID_INPUT",
      userMessage: reflection.error.message,
      suggestedActions: ["Add at least one reflection field"],
      retryability: "NO_RETRY",
      recoveryStrategy: "USER_ACTION",
      severity: "WARNING",
    });
  }
  const updated = input.mission.setReflection(reflection.value);
  if (!updated.ok) {
    throw createKestrelError({
      code: "DM_STATE_CORRUPTED",
      category: "FATAL",
      userMessage: "Failed to record reflection",
      suggestedActions: [],
      retryability: "NO_RETRY",
      recoveryStrategy: "MANUAL_INTERVENTION",
      severity: "FATAL",
    });
  }
  const event = createJourneyEvent({
    eventId: deps.idGenerator.newEventId(),
    missionId: input.mission.id,
    type: "ReflectionAdded",
    occurredAt: deps.clock.now(),
    payload: { summary: input.reflection.lesson ?? input.reflection.notes ?? "" },
  });
  if (!event.ok) {
    throw createKestrelError({
      code: "DM_STATE_CORRUPTED",
      category: "FATAL",
      userMessage: "Failed to build the reflection event",
      suggestedActions: [],
      retryability: "NO_RETRY",
      recoveryStrategy: "MANUAL_INTERVENTION",
      severity: "FATAL",
    });
  }
  await commitMissionChange(
    {
      lock: deps.lock,
      journal: deps.journal,
      missionStore: deps.missionStore,
      journeyStore: deps.journeyStore,
      indexStore: deps.indexStore,
    },
    {
      transactionId: deps.idGenerator.newTransactionId(),
      missionId: input.mission.id,
      sidecarPath: input.sidecarPath,
      operation: "reflect",
      expectedStateVersion: input.expectedStateVersion,
      targetMission: updated.value,
      event: event.value,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    },
  );
  return updated.value;
}
