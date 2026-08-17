import { createHash } from "node:crypto";
import { createJourneyEvent } from "../../domain/journey/journey-event.js";
import { createAgentHandoff } from "../../domain/agent/agent-handoff.js";
import type { AgentHandoff } from "../../domain/agent/agent-handoff.js";
import type { Mission } from "../../domain/mission/mission.js";
import { policyFor } from "../../domain/policy/policies.js";
import type { Clock } from "../../ports/clock.js";
import type { IdGenerator } from "../../ports/id-generator.js";
import type { AgentHandoffStore } from "../../ports/agent-handoff-store.js";
import type { JourneyStore } from "../../ports/journey-store.js";
import type { MissionIndexStore } from "../../ports/mission-index-store.js";
import type { MissionLock } from "../../ports/mission-lock.js";
import type { MissionStore } from "../../ports/mission-store.js";
import type { TransactionJournal } from "../../ports/transaction-journal.js";
import { createKestrelError } from "../errors/kestrel-error.js";
import { buildAgentBrief } from "./build-agent-brief.js";
import type { PromptRenderer } from "./prompt-renderer.js";
import { commitMissionChange } from "../transactions/commit-mission-change.js";

export interface RecordAgentHandoffDeps {
  readonly lock: MissionLock;
  readonly journal: TransactionJournal;
  readonly missionStore: MissionStore;
  readonly journeyStore: JourneyStore;
  readonly indexStore: MissionIndexStore;
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
  readonly renderer: PromptRenderer;
  readonly handoffStore: AgentHandoffStore;
}

export interface RecordAgentHandoffInput {
  readonly mission: Mission;
  readonly sidecarPath: string;
  readonly lockPath: string;
  readonly expectedStateVersion: number;
  readonly hypothesis?: string;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Render, hash, and record an immutable agent handoff. */
export async function recordAgentHandoff(
  deps: RecordAgentHandoffDeps,
  input: RecordAgentHandoffInput,
): Promise<AgentHandoff> {
  const brief = buildAgentBrief(deps.clock, {
    mission: input.mission,
    ...(input.hypothesis !== undefined ? { hypothesis: input.hypothesis } : {}),
  });
  const rendered = deps.renderer.render(brief);
  const hash = sha256Hex(rendered);
  const handoff = createAgentHandoff({
    handoffId: deps.idGenerator.newHandoffId(),
    missionId: input.mission.id,
    policyVersion: policyFor(input.mission.challengeSnapshot.type).version,
    renderer: "generic",
    createdAt: deps.clock.now(),
    ...(input.hypothesis !== undefined ? { developerHypothesisSnapshot: input.hypothesis } : {}),
    briefSnapshot: brief,
    renderedPromptHash: hash,
  });
  if (!handoff.ok) {
    throw createKestrelError({
      code: "DM_STATE_CORRUPTED",
      category: "FATAL",
      userMessage: "Failed to build the agent handoff",
      suggestedActions: [],
      retryability: "NO_RETRY",
      recoveryStrategy: "MANUAL_INTERVENTION",
      severity: "FATAL",
    });
  }

  const event = createJourneyEvent({
    eventId: deps.idGenerator.newEventId(),
    missionId: input.mission.id,
    type: "AgentHandoffRecorded",
    occurredAt: deps.clock.now(),
    payload: { handoffId: handoff.value.handoffId },
  });
  if (!event.ok) {
    throw createKestrelError({
      code: "DM_STATE_CORRUPTED",
      category: "FATAL",
      userMessage: "Failed to build the handoff event",
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
      handoffStore: deps.handoffStore,
    },
    {
      transactionId: deps.idGenerator.newTransactionId(),
      missionId: input.mission.id,
      sidecarPath: input.sidecarPath,
      operation: "handoff",
      expectedStateVersion: input.expectedStateVersion,
      targetMission: input.mission,
      event: event.value,
      handoff: handoff.value,
    },
  );
  return handoff.value;
}
