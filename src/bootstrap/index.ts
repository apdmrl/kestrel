import { homedir } from "node:os";
import { join } from "node:path";
import { FileSystemMissionStore } from "../infrastructure/persistence/file-system-mission-store.js";
import { FileSystemPreferencesStore } from "../infrastructure/persistence/file-system-preferences-store.js";
import { FileSystemMissionIndexStore } from "../infrastructure/persistence/file-system-mission-index-store.js";
import { JsonlJourneyStore } from "../infrastructure/persistence/jsonl-journey-store.js";
import { FileMissionLock } from "../infrastructure/locking/file-mission-lock.js";
import { FileTransactionJournal } from "../infrastructure/transactions/file-transaction-journal.js";
import { recoverTransactions } from "../application/transactions/recover-transactions.js";
import { projectProgress } from "../application/journey/journey-projector.js";
import { getCurrentMission } from "../application/mission/get-current-mission.js";
import type { CommandHandlers } from "../cli/command-handlers.js";
import type { ViewModel } from "../cli/presentation/view-models.js";

export interface KestrelConfig {
  readonly home: string;
  readonly workspaceRoot: string;
}

export function createConfig(env: Record<string, string | undefined>): KestrelConfig {
  return {
    home: env.KESTREL_HOME ?? join(homedir(), ".kestrel"),
    workspaceRoot: env.KESTREL_WORKSPACE ?? join(homedir(), "Kestrel", "missions"),
  };
}

/** Compose the concrete adapters, recover pending transactions, and expose CLI handlers. */
export async function bootstrap(config: KestrelConfig): Promise<CommandHandlers> {
  const missionStore = new FileSystemMissionStore();
  const preferencesStore = new FileSystemPreferencesStore(join(config.home, "preferences.json"));
  const indexStore = new FileSystemMissionIndexStore(join(config.home, "index.json"));
  const journeyStore = new JsonlJourneyStore(join(config.home, "journey", "events.jsonl"));
  const lock = new FileMissionLock();
  const journal = new FileTransactionJournal(join(config.home, "transactions"));

  await recoverTransactions({ lock, journal, missionStore, journeyStore });

  const progressView = async (): Promise<ViewModel> => {
    const events = await journeyStore.readAll();
    return { kind: "progress", counts: projectProgress(events) };
  };

  return {
    find: async () => ({
      kind: "error",
      code: "DM_GITHUB_AUTH_EXPIRED",
      userMessage: "GitHub authentication is required for discovery",
      suggestedActions: ["Run kestrel auth"],
    }),
    missionCurrent: async () => {
      const result = await getCurrentMission({ missionStore, missionIndexStore: indexStore }, {});
      if (result.kind === "mission") {
        return {
          kind: "mission",
          id: result.mission.id,
          status: result.mission.status,
          title: result.mission.challengeSnapshot.title,
        };
      }
      return { kind: "verification", text: "No active mission" };
    },
    journey: progressView,
    progress: progressView,
    preferencesGet: async () => {
      await preferencesStore.get();
      return {
        kind: "progress",
        counts: { accepted: 0, completed: 0, submitted: 0, linked: 0, merged: 0, abandoned: 0 },
      };
    },
    preferencesSet: async () => ({
      kind: "progress",
      counts: { accepted: 0, completed: 0, submitted: 0, linked: 0, merged: 0, abandoned: 0 },
    }),
  };
}
