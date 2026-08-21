import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { Octokit } from "octokit";
import { createOAuthDeviceAuth } from "@octokit/auth-oauth-device";
import { FileSystemMissionStore } from "../infrastructure/persistence/file-system-mission-store.js";
import { FileSystemPreferencesStore } from "../infrastructure/persistence/file-system-preferences-store.js";
import { FileSystemMissionIndexStore } from "../infrastructure/persistence/file-system-mission-index-store.js";
import {
  FileSystemRecommendationStore,
  migrateLegacyRecommendation,
} from "../infrastructure/persistence/file-system-recommendation-store.js";
import { JsonlJourneyStore } from "../infrastructure/persistence/jsonl-journey-store.js";
import { FileSystemAgentHandoffStore } from "../infrastructure/persistence/file-system-agent-handoff-store.js";
import { FileMissionLock } from "../infrastructure/locking/file-mission-lock.js";
import { FileTransactionJournal } from "../infrastructure/transactions/file-transaction-journal.js";
import { FileRecoveryBarrier } from "../infrastructure/transactions/file-recovery-barrier.js";
import {
  resetRecoveryBarrier,
  setRecoveryBarrier,
} from "../application/transactions/recovery-barrier.js";
import { ExecaProcessRunner } from "../infrastructure/process/execa-process-runner.js";
import { GitCredentialStore } from "../infrastructure/credentials/git-credential-store.js";
import { SystemClock } from "../infrastructure/system/system-clock.js";
import { CryptoIdGenerator } from "../infrastructure/system/crypto-id-generator.js";
import { FilesystemWorkspaceManager } from "../infrastructure/workspace/filesystem-workspace-manager.js";
import { verifyTrustedLockTarget } from "../infrastructure/recovery/trusted-lock-target.js";
import { SystemGitClient } from "../infrastructure/git/system-git-client.js";
import { OctokitGateway } from "../infrastructure/github/octokit-gateway.js";
import { GithubChallengeSource } from "../infrastructure/github/github-challenge-source.js";
import { genericPromptRenderer } from "../application/agent/generic-prompt-renderer.js";
import { authenticateGitHub } from "../application/auth/authenticate-github.js";
import type { ChallengeSource } from "../ports/challenge-source.js";
import type { CredentialStore } from "../ports/credential-store.js";
import type { GitHubGateway } from "../ports/github-gateway.js";
import { findChallenge } from "../application/discovery/find-challenge.js";
import { acceptMission } from "../application/mission/accept-mission.js";
import {
  prepareMission,
  resumeMissionPreparation,
  type PrepareMissionDeps,
} from "../application/mission/prepare-mission.js";
import { getCurrentMission } from "../application/mission/get-current-mission.js";
import { completeMission } from "../application/mission/complete-mission.js";
import { abandonMission } from "../application/mission/abandon-mission.js";
import { recordAgentHandoff } from "../application/agent/record-agent-handoff.js";
import { verifySubmission } from "../application/verification/verify-submission.js";
import { verifyIssueLink } from "../application/verification/verify-issue-link.js";
import { verifyMerge } from "../application/verification/verify-merge.js";
import { getJourney } from "../application/journey/get-journey.js";
import { getProgress } from "../application/journey/get-progress.js";
import { getPreferences } from "../application/preferences/get-preferences.js";
import { updatePreferences } from "../application/preferences/update-preferences.js";
import { recoverTransactions } from "../application/transactions/recover-transactions.js";
import { createKestrelError } from "../application/errors/kestrel-error.js";
import { createSearchIntent } from "../domain/discovery/search-intent.js";
import {
  createExplicitPreferences,
  resolveDeveloperContext,
  type DeveloperMode,
  type ExplicitPreferences,
} from "../domain/preferences/preferences.js";
import type { LearnedSignals } from "../domain/preferences/learned-signals.js";
import { isMood, type Mood } from "../domain/recommendation/mood.js";
import { snapshotRecommendation } from "../domain/recommendation/recommendation.js";
import { parseChallengeId, parseMissionId } from "../domain/shared/identifiers.js";
import type { ChallengeType } from "../domain/challenge/challenge.js";
import type { Mission } from "../domain/mission/mission.js";
import type { MissionId } from "../domain/shared/identifiers.js";
import type { CommandHandlers } from "../cli/command-handlers.js";
import type { ViewModel } from "../cli/presentation/view-models.js";

export interface KestrelConfig {
  readonly home: string;
  readonly workspaceRoot: string;
  readonly githubClientId: string | undefined;
  readonly githubApiUrl: string | undefined;
}

export interface BootstrapOptions {
  /** Whether device flow may present interactive instructions. Defaults to true. */
  readonly interactive?: boolean;
  /** Cancellation signal that aborts cancellation-aware operations gracefully. */
  readonly signal?: AbortSignal;
  /** Whether to run journal replay before exposing handlers. Defaults to true. */
  readonly recover?: boolean;
  /** Writes user-facing device-flow instructions (verification URI and user code). */
  readonly writeAuth?: (text: string) => void;
  /** Overrides for adapters, used by tests and alternative compositions. */
  readonly credentialStore?: CredentialStore;
  readonly gateway?: GitHubGateway;
  readonly challengeSourceFactory?: (token: string) => ChallengeSource;
}

export function createConfig(env: Record<string, string | undefined>): KestrelConfig {
  return {
    home: env.KESTREL_HOME ?? join(homedir(), ".kestrel"),
    workspaceRoot: env.KESTREL_WORKSPACE ?? join(homedir(), "Kestrel", "missions"),
    githubClientId: env.GITHUB_CLIENT_ID,
    githubApiUrl: env.GITHUB_API_URL,
  };
}

const CHALLENGE_TYPES: ReadonlySet<string> = new Set(["BUG_FIX", "TESTING", "DOCUMENTATION"]);
const MODES: ReadonlySet<string> = new Set(["GUIDED", "EXPERT"]);

function invalidInput(message: string): ReturnType<typeof createKestrelError> {
  return createKestrelError({
    code: "DM_ILLEGAL_TRANSITION",
    category: "INVALID_INPUT",
    userMessage: message,
    suggestedActions: ["Check the command options and retry"],
    retryability: "NO_RETRY",
    recoveryStrategy: "USER_ACTION",
    severity: "WARNING",
  });
}

function noMission(message: string): ReturnType<typeof createKestrelError> {
  return createKestrelError({
    code: "DM_MISSION_NOT_FOUND",
    category: "USER_ACTION_REQUIRED",
    userMessage: message,
    suggestedActions: ["Accept a mission with 'kestrel mission accept'"],
    retryability: "NO_RETRY",
    recoveryStrategy: "USER_ACTION",
    severity: "WARNING",
  });
}

function recommendationNotFound(): ReturnType<typeof createKestrelError> {
  return createKestrelError({
    code: "DM_RECOMMENDATION_NOT_FOUND",
    category: "USER_ACTION_REQUIRED",
    userMessage: "No matching recommendation was found",
    suggestedActions: ["Run 'kestrel find' first, then accept the recommendation it shows"],
    retryability: "NO_RETRY",
    recoveryStrategy: "USER_ACTION",
    severity: "WARNING",
  });
}

function missionView(mission: Mission): ViewModel {
  return {
    kind: "mission",
    id: mission.id,
    status: mission.status,
    title: mission.challengeSnapshot.title,
    verification: mission.submissionVerification,
    repository:
      mission.challengeSnapshot.repository.owner + "/" + mission.challengeSnapshot.repository.name,
    ...(mission.branch !== undefined ? { branch: mission.branch } : {}),
  };
}

/** Compose the concrete adapters, recover pending transactions, and expose CLI handlers. */
export async function bootstrap(
  config: KestrelConfig,
  options: BootstrapOptions = {},
): Promise<CommandHandlers> {
  // The recovery barrier is a built-CLI test hook only: it activates exclusively
  // under NODE_ENV=test with the dedicated test-barrier variables set. Normal
  // production composition keeps the no-op barrier.
  if (
    process.env.NODE_ENV === "test" &&
    process.env.KESTREL_RECOVERY_BARRIER_MARKER_DIR !== undefined &&
    process.env.KESTREL_RECOVERY_BARRIER_RELEASE !== undefined
  ) {
    setRecoveryBarrier(
      new FileRecoveryBarrier(
        process.env.KESTREL_RECOVERY_BARRIER_MARKER_DIR,
        process.env.KESTREL_RECOVERY_BARRIER_RELEASE,
        process.env.KESTREL_RECOVERY_BARRIER_MATCH,
      ),
    );
  } else {
    resetRecoveryBarrier();
  }
  const lock = new FileMissionLock();
  const missionStore = new FileSystemMissionStore();
  const preferencesStore = new FileSystemPreferencesStore(join(config.home, "preferences.json"));
  const indexStore = new FileSystemMissionIndexStore(
    join(config.home, "index.json"),
    lock,
    join(config.home, "index.json.lock"),
  );
  const handoffStore = new FileSystemAgentHandoffStore();
  const journeyStore = new JsonlJourneyStore(join(config.home, "journey", "events.jsonl"));
  const recommendationStore = new FileSystemRecommendationStore(
    join(config.home, "recommendations"),
  );
  // Migrate the legacy single-latest recommendation file into the per-id store
  // so a recommendation shown before the upgrade can still be accepted without
  // re-running find. Best-effort and non-fatal: inconsistencies are preserved and
  // reported on stderr (never on JSON stdout); a failure never blocks startup.
  try {
    await migrateLegacyRecommendation(
      join(config.home, "recommendation.json"),
      recommendationStore,
      (message) => process.stderr.write(message + "\n"),
    );
  } catch {
    process.stderr.write("Legacy recommendation migration failed; continuing.\n");
  }
  const journal = new FileTransactionJournal(join(config.home, "transactions"));
  const runner = new ExecaProcessRunner();
  const credentialStore = options.credentialStore ?? new GitCredentialStore(runner);
  const clock = new SystemClock();
  const idGenerator = new CryptoIdGenerator();
  const workspaceManager = new FilesystemWorkspaceManager();
  const gitFactory = (cwd: string, signal?: AbortSignal) =>
    new SystemGitClient(cwd, runner, signal);
  const octokitOptions = config.githubApiUrl !== undefined ? { baseUrl: config.githubApiUrl } : {};
  const gateway =
    options.gateway ??
    new OctokitGateway(
      new Octokit(octokitOptions),
      config.githubClientId ?? "",
      createOAuthDeviceAuth,
    );
  // Authorization guidance is presentation, never machine output: default it
  // to stderr so --json stdout stays a single parseable JSON document. The CLI
  // composition root may supply an explicit presentation channel instead.
  const writeAuth = options.writeAuth ?? ((text: string) => process.stderr.write(text));
  const interactive = options.interactive ?? true;

  // Journal replay runs before ordinary commands so pending transactions finish
  // first. Recovery mode (the exact `mission break-lock` invocation) skips this
  // so a stale lock that replay would trip over can be cleared first.
  if (options.recover !== false) {
    await recoverTransactions({
      lock,
      journal,
      missionStore,
      journeyStore,
      indexStore,
      handoffStore,
    });
  }

  const loadPreferences = async (): Promise<{
    explicit: ExplicitPreferences;
    learned: LearnedSignals;
    version: number;
  }> => {
    const { explicit, learned, version } = await getPreferences({ preferencesStore, journeyStore });
    return { explicit, learned, version };
  };

  const requireGithubToken = async (): Promise<string> => {
    // Always validate cached tokens and present the device-flow verification
    // code. The verification URI and short user code are safe to display; the
    // device code and access token are never written out.
    const auth = await authenticateGitHub(
      { credentialStore, gateway },
      {
        account: "github",
        interactive,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        onAuthorization: (authorization) => {
          writeAuth(
            "To authenticate, open " +
              authorization.verificationUri +
              " and enter the code " +
              authorization.userCode +
              "\n",
          );
        },
      },
    );
    return auth.token;
  };

  const resolveMission = async (
    missionId?: string,
  ): Promise<{
    mission: Mission;
    sidecarPath: string;
    lockPath: string;
    version: number;
  }> => {
    const result = await getCurrentMission(
      { missionStore, missionIndexStore: indexStore },
      missionId !== undefined ? { missionId: parseRequiredMissionId(missionId) } : {},
    );
    if (result.kind !== "mission") {
      throw noMission(
        result.kind === "ambiguous"
          ? "Multiple active missions exist; specify one with --id"
          : "No active mission to operate on",
      );
    }
    return {
      mission: result.mission,
      sidecarPath: result.sidecarPath,
      lockPath: join(result.sidecarPath, ".lock"),
      version: result.version,
    };
  };

  const parseRequiredMissionId = (missionId: string) => {
    const parsed = parseMissionId(missionId);
    if (!parsed.ok) {
      throw invalidInput(parsed.error.message);
    }
    return parsed.value;
  };

  const conflictingLocations = () =>
    createKestrelError({
      code: "DM_ILLEGAL_TRANSITION",
      category: "INVALID_INPUT",
      userMessage: "Mission recovery sources disagree on the mission location",
      suggestedActions: ["Inspect the index and pending transactions"],
      retryability: "NO_RETRY",
      recoveryStrategy: "MANUAL_INTERVENTION",
      severity: "ERROR",
    });

  const canonicalizePath = async (path: string): Promise<string> => {
    const resolved = resolve(path);
    try {
      return await realpath(resolved);
    } catch {
      return resolved;
    }
  };

  /**
   * Resolve the exact sidecar for a recovery target from validated index data or
   * validated matching pending intents. Never accepts a filesystem path from
   * the user. Every matching source is collected and canonicalized, and the
   * recovery requires exactly one unique location; `find()` is never used to
   * select an arbitrary intent, so two conflicting sources cannot silently pick
   * a winner based on directory enumeration order.
   */
  const resolveRecoverySidecar = async (missionId: string): Promise<string> => {
    const { index } = await indexStore.get();
    const indexPaths = index.entries
      .filter((entry) => entry.missionId === missionId)
      .map((entry) => entry.sidecarPath);
    const intents = await journal.listPending();
    const intentPaths = intents
      .filter((intent) => intent.missionId === missionId)
      .map((intent) => intent.sidecarPath);
    const candidates = [...indexPaths, ...intentPaths];
    if (candidates.length === 0) {
      throw noMission("No mission found to break a stale lock for");
    }
    // Canonicalize every source (realpath when present, else a lexical resolve)
    // so syntactically different paths to the same target are treated as one.
    const unique = [...new Set(await Promise.all(candidates.map(canonicalizePath)))];
    if (unique.length > 1) {
      throw conflictingLocations();
    }
    return unique[0] as string;
  };

  const loadRecommendation = async (recommendationId: string) => {
    const parsed = parseChallengeId(recommendationId);
    if (!parsed.ok) {
      throw invalidInput(parsed.error.message);
    }
    return recommendationStore.load(parsed.value);
  };

  const discover = async (mood: string, type?: string) => {
    const moodValue: Mood = isMood(mood) ? mood : "QUICK_WIN";
    const typeValue = type !== undefined ? validateChallengeType(type) : undefined;
    const token = await requireGithubToken();
    const source =
      options.challengeSourceFactory !== undefined
        ? options.challengeSourceFactory(token)
        : new GithubChallengeSource(
            new Octokit({ ...octokitOptions, auth: token }),
            clock,
            idGenerator,
          );
    const preferences = await loadPreferences();
    const developer = resolveDeveloperContext(preferences.explicit, preferences.learned);
    const intent = createSearchIntent({
      mood: moodValue,
      explicitPreferences: preferences.explicit,
      ...(typeValue !== undefined ? { missionTypeOverride: typeValue } : {}),
      pageBudget: 5,
    });
    if (!intent.ok) {
      throw invalidInput(intent.error.message);
    }
    return findChallenge(
      { source, developer, clock },
      {
        mode: "PICK_ONE",
        mood: moodValue,
        intent: intent.value,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      },
    );
  };

  const prepareDeps = (signal?: AbortSignal): PrepareMissionDeps => ({
    lock,
    journal,
    missionStore,
    journeyStore,
    indexStore,
    workspaceManager,
    idGenerator,
    clock,
    gitFactory,
    ...(signal !== undefined ? { signal } : {}),
  });

  return {
    find: async ({ mood, type }) => {
      const result = await discover(mood, type);
      if (result.kind === "empty") {
        return { kind: "verification", text: "No challenge found" };
      }
      const recommendation = result.recommendation;
      // Persist the exact recommendation so a later accept binds to it instead
      // of silently performing a replacement search.
      await recommendationStore.save(snapshotRecommendation(recommendation));
      return {
        kind: "recommendation",
        recommendationId: recommendation.challenge.id,
        challengeId: recommendation.challenge.id,
        title: recommendation.challenge.title,
        mood: recommendation.mood,
        confidence: recommendation.confidence,
        reasons: recommendation.reasons,
      };
    },
    missionAccept: async ({ recommendationId }) => {
      const recommendation = await loadRecommendation(recommendationId);
      if (recommendation === undefined) {
        throw recommendationNotFound();
      }
      const preferences = await loadPreferences();
      const workspaceRoot = preferences.explicit.workspaceRoot ?? config.workspaceRoot;
      const mission = await acceptMission(
        {
          lock,
          journal,
          missionStore,
          journeyStore,
          indexStore,
          workspaceManager,
          idGenerator,
          clock,
        },
        {
          recommendation,
          mode: preferences.explicit.defaultMode,
          workspaceRoot,
        },
      );
      return missionView(mission);
    },
    missionPrepare: async ({ missionId }) => {
      const resolved = await resolveMission(missionId);
      const prepared = await prepareMission(prepareDeps(options.signal), {
        missionId: resolved.mission.id,
        sidecarPath: resolved.sidecarPath,
      });
      return missionView(prepared);
    },
    missionResume: async ({ missionId }) => {
      const resolved = await resolveMission(missionId);
      const prepared = await resumeMissionPreparation(prepareDeps(options.signal), {
        missionId: resolved.mission.id,
        sidecarPath: resolved.sidecarPath,
      });
      return missionView(prepared);
    },
    missionCurrent: async ({ missionId } = {}) => {
      const result = await getCurrentMission(
        { missionStore, missionIndexStore: indexStore },
        missionId !== undefined ? { missionId: parseRequiredMissionId(missionId) } : {},
      );
      if (result.kind !== "mission") {
        return { kind: "verification", text: "No active mission" };
      }
      return missionView(result.mission);
    },
    missionBreakLock: async ({ missionId }) => {
      const id = parseRequiredMissionId(missionId);
      const candidate = await resolveRecoverySidecar(id);
      // Fail closed: derive and verify a trusted mission location inside the
      // managed workspace root before deleting anything. A raw index/intent
      // sidecar path is never trusted as-is.
      const trusted = await verifyTrustedLockTarget({
        workspaceRoot: config.workspaceRoot,
        missionId: id,
        sidecarPath: candidate,
      });
      // Recover the mission lock first, then the shared global index lock that
      // replay needs. breakStaleLock refuses any live lock.
      await lock.breakStaleLock(trusted.lockPath, id);
      await lock.breakStaleLock(join(config.home, "index.json.lock"), "index" as MissionId);
      return {
        kind: "verification",
        text: "Stale mission lock cleared for " + id,
      };
    },
    missionComplete: async ({ missionId }) => {
      const resolved = await resolveMission(missionId);
      const repositoryPath = resolved.mission.workspace?.repositoryPath ?? "";
      const completed = await completeMission(
        {
          lock,
          journal,
          missionStore,
          journeyStore,
          indexStore,
          git: gitFactory(repositoryPath),
          idGenerator,
          clock,
        },
        {
          mission: resolved.mission,
          sidecarPath: resolved.sidecarPath,
          lockPath: resolved.lockPath,
          expectedStateVersion: resolved.version,
        },
      );
      return missionView(completed);
    },
    missionAbandon: async ({ missionId, reason }) => {
      if (reason.trim().length === 0) {
        throw invalidInput("An abandon reason is required (--reason)");
      }
      const resolved = await resolveMission(missionId);
      const abandoned = await abandonMission(
        { lock, journal, missionStore, journeyStore, indexStore, idGenerator, clock },
        {
          mission: resolved.mission,
          sidecarPath: resolved.sidecarPath,
          lockPath: resolved.lockPath,
          expectedStateVersion: resolved.version,
          reason,
        },
      );
      return missionView(abandoned);
    },
    agentBrief: async ({ missionId, hypothesis }) => {
      const resolved = await resolveMission(missionId);
      const handoff = await recordAgentHandoff(
        {
          lock,
          journal,
          missionStore,
          journeyStore,
          indexStore,
          idGenerator,
          clock,
          renderer: genericPromptRenderer,
          handoffStore,
        },
        {
          mission: resolved.mission,
          sidecarPath: resolved.sidecarPath,
          lockPath: resolved.lockPath,
          expectedStateVersion: resolved.version,
          ...(hypothesis !== undefined ? { hypothesis } : {}),
        },
      );
      return {
        kind: "handoff",
        handoffId: handoff.handoffId,
        renderedPromptHash: handoff.renderedPromptHash,
      };
    },
    verifySubmission: async ({ missionId, prNumber }) => {
      validatePrNumber(prNumber);
      const resolved = await resolveMission(missionId);
      const token = await requireGithubToken();
      const repositoryPath = resolved.mission.workspace?.repositoryPath ?? "";
      const result = await verifySubmission(
        {
          lock,
          journal,
          missionStore,
          journeyStore,
          indexStore,
          gateway,
          git: gitFactory(repositoryPath, options.signal),
          idGenerator,
          clock,
        },
        {
          mission: resolved.mission,
          sidecarPath: resolved.sidecarPath,
          lockPath: resolved.lockPath,
          expectedStateVersion: resolved.version,
          token,
          prNumber,
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        },
      );
      if (result.kind === "submitted") {
        return missionView(result.mission);
      }
      return {
        kind: "verification",
        text:
          "Not submitted: " + (result.reasons.length > 0 ? result.reasons.join("; ") : "no match"),
      };
    },
    verifyLink: async ({ missionId, prNumber }) => {
      validatePrNumber(prNumber);
      const resolved = await resolveMission(missionId);
      const token = await requireGithubToken();
      const result = await verifyIssueLink(
        { lock, journal, missionStore, journeyStore, indexStore, gateway, idGenerator, clock },
        {
          mission: resolved.mission,
          sidecarPath: resolved.sidecarPath,
          lockPath: resolved.lockPath,
          expectedStateVersion: resolved.version,
          token,
          prNumber,
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        },
      );
      if (result.kind === "linked") {
        return missionView(result.mission);
      }
      return { kind: "verification", text: "No issue link detected" };
    },
    verifyMerge: async ({ missionId, prNumber }) => {
      validatePrNumber(prNumber);
      const resolved = await resolveMission(missionId);
      const token = await requireGithubToken();
      const result = await verifyMerge(
        { lock, journal, missionStore, journeyStore, indexStore, gateway, idGenerator, clock },
        {
          mission: resolved.mission,
          sidecarPath: resolved.sidecarPath,
          lockPath: resolved.lockPath,
          expectedStateVersion: resolved.version,
          token,
          prNumber,
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        },
      );
      if (result.kind === "merged") {
        return missionView(result.mission);
      }
      return { kind: "verification", text: "Pull request is not merged" };
    },
    journey: async () => {
      const summaries = await getJourney({ journeyStore });
      return {
        kind: "journey",
        entries: summaries.map((entry) => ({
          type: entry.type,
          missionId: entry.missionId,
          occurredAt: entry.occurredAt,
        })),
      };
    },
    progress: async () => {
      const counts = await getProgress({ journeyStore });
      return { kind: "progress", counts };
    },
    preferencesGet: async () => {
      const preferences = await loadPreferences();
      return {
        kind: "preferences",
        version: preferences.version,
        preferredLanguages: preferences.explicit.preferredLanguages,
        preferredDifficulty: preferences.explicit.preferredDifficulty ?? null,
        defaultMode: preferences.explicit.defaultMode,
        workspaceRoot: preferences.explicit.workspaceRoot ?? null,
      };
    },
    preferencesSet: async ({ language, mode }) => {
      if (mode !== undefined && !MODES.has(mode)) {
        throw invalidInput("Mode must be GUIDED or EXPERT");
      }
      const preferences = await loadPreferences();
      const explicit = createExplicitPreferences({
        preferredLanguages:
          language !== undefined ? [language] : preferences.explicit.preferredLanguages,
        ...(preferences.explicit.preferredDifficulty !== undefined
          ? { preferredDifficulty: preferences.explicit.preferredDifficulty }
          : {}),
        defaultMode:
          mode !== undefined ? (mode as DeveloperMode) : preferences.explicit.defaultMode,
        ...(preferences.explicit.workspaceRoot !== undefined
          ? { workspaceRoot: preferences.explicit.workspaceRoot }
          : {}),
      });
      if (!explicit.ok) {
        throw invalidInput(explicit.error.message);
      }
      await updatePreferences(
        { preferencesStore },
        { preferences: explicit.value, expectedVersion: preferences.version },
      );
      return {
        kind: "preferences",
        version: preferences.version + 1,
        preferredLanguages: explicit.value.preferredLanguages,
        preferredDifficulty: explicit.value.preferredDifficulty ?? null,
        defaultMode: explicit.value.defaultMode,
        workspaceRoot: explicit.value.workspaceRoot ?? null,
      };
    },
  };
}

function validateChallengeType(type: string): ChallengeType {
  if (!CHALLENGE_TYPES.has(type)) {
    throw invalidInput("Type must be BUG_FIX, TESTING, or DOCUMENTATION");
  }
  return type as ChallengeType;
}

function validatePrNumber(prNumber: number): void {
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw invalidInput("--pr must be a positive integer");
  }
}
