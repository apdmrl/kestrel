import { describe, expect, it } from "vitest";
import { createChallenge } from "../../domain/challenge/challenge.js";
import {
  createRecommendation,
  snapshotRecommendation,
} from "../../domain/recommendation/recommendation.js";
import type { Challenge } from "../../domain/challenge/challenge.js";
import type { ChallengeId } from "../../domain/shared/identifiers.js";
import type { EventId } from "../../domain/shared/identifiers.js";
import type { EvidenceId } from "../../domain/evidence/evidence.js";
import type { HandoffId, MissionId, TransactionId } from "../../domain/shared/identifiers.js";
import type { IsoDateTime } from "../../domain/shared/time.js";
import type { RecommendationSnapshot } from "../../domain/recommendation/recommendation.js";
import type { WorkspaceInfo } from "../../domain/mission/mission.js";
import { Mission } from "../../domain/mission/mission.js";
import type { JourneyEvent } from "../../domain/journey/journey-event.js";
import type {
  GitHubGateway,
  GitHubToken,
  GitHubViewer,
  DeviceFlowAuthorization,
  PullRequestInfo,
  IssueLinkResult,
  MergeInfo,
} from "../../ports/github-gateway.js";
import type { RepositoryIdentity } from "../../domain/challenge/repository-identity.js";
import type { GitClient, LocalChanges } from "../../ports/git-client.js";
import type { JourneyStore } from "../../ports/journey-store.js";
import type { MissionLock } from "../../ports/mission-lock.js";
import type { MissionStore, StoredMission } from "../../ports/mission-store.js";
import type { TransactionJournal } from "../../ports/transaction-journal.js";
import { recordAllPreparationCheckpoints } from "../../test-utils/prepare.js";
import { createKestrelError } from "../errors/kestrel-error.js";
import { verifySubmission } from "./verify-submission.js";
import { verifyIssueLink } from "./verify-issue-link.js";
import { FakeIndexStore } from "../../test-utils/fake-index-store.js";

const now = "2026-08-15T10:00:00Z" as IsoDateTime;

function makeChallenge(): Challenge {
  const result = createChallenge({
    id: "c1" as ChallengeId,
    externalId: "1",
    repository: { provider: "github", owner: "octocat", name: "hello-world" },
    issueNumber: 42,
    canonicalUrl: "https://github.com/octocat/hello-world/issues/42",
    title: "Fix crash",
    description: "d",
    type: "BUG_FIX",
    createdAt: "2026-08-01T00:00:00Z" as IsoDateTime,
    updatedAt: "2026-08-01T00:00:00Z" as IsoDateTime,
  });
  if (!result.ok) {
    throw new Error("expected ok");
  }
  return result.value;
}

function makeRecommendation(challenge: Challenge): RecommendationSnapshot {
  const result = createRecommendation({
    challenge,
    mood: "QUICK_WIN",
    signalResults: [{ name: "interest", value: 0.9, confidence: 0.8, reason: "matches" }],
    confidence: 0.8,
    evaluatedAt: now,
  });
  if (!result.ok) {
    throw new Error("expected ok");
  }
  return snapshotRecommendation(result.value);
}

function inProgressMission(): Mission {
  const workspace: WorkspaceInfo = {
    root: "/tmp/ws",
    missionDirectory: "/tmp/ws/m1",
    repositoryPath: "/tmp/ws/m1/repo",
    sidecarPath: "/tmp/ws/m1/kestrel",
  };
  const accepted = Mission.accept({
    id: "m1" as MissionId,
    challengeSnapshot: makeChallenge(),
    recommendationSnapshot: makeRecommendation(makeChallenge()),
    mode: "GUIDED",
    acceptedAt: now,
  });
  const preparing = accepted.ok ? accepted.value.startPreparation() : null;
  const ready = preparing?.ok ? recordAllPreparationCheckpoints(preparing.value) : null;
  const inProgress = ready?.completePreparation({ workspace, baseCommit: "base", branch: "b" });
  if (!inProgress?.ok) {
    throw new Error("expected ok");
  }
  return inProgress.value;
}

class FakeGateway implements GitHubGateway {
  pr: PullRequestInfo = {
    number: 99,
    url: "https://github.com/octocat/hello-world/pull/99",
    repository: { provider: "github", owner: "octocat", name: "hello-world" },
    author: "octocat",
    commits: ["abc"],
    state: "OPEN",
  };
  link: IssueLinkResult | undefined = {
    issueNumber: 42,
    repository: { provider: "github", owner: "octocat", name: "hello-world" },
    relationship: "CLOSING_KEYWORD",
  };
  rateLimited = false;

  async beginDeviceFlow(): Promise<DeviceFlowAuthorization> {
    throw new Error("unused");
  }
  async pollForToken(): Promise<GitHubToken> {
    throw new Error("unused");
  }
  async getViewer(): Promise<GitHubViewer> {
    return { login: "octocat", id: 1 };
  }
  async getPullRequest(_r: RepositoryIdentity, _n: number): Promise<PullRequestInfo> {
    if (this.rateLimited) {
      throw createKestrelError({
        code: "DM_GITHUB_RATE_LIMITED",
        category: "TRANSIENT",
        userMessage: "rate limited",
        suggestedActions: ["wait"],
        retryability: "RETRY_WITH_BACKOFF",
        recoveryStrategy: "RETRY",
        severity: "ERROR",
      });
    }
    return this.pr;
  }
  async getIssueLinkage(): Promise<IssueLinkResult | undefined> {
    return this.link;
  }
  async getMergeInfo(): Promise<MergeInfo> {
    return { merged: false, mergeSha: undefined, mergedAt: undefined };
  }
}

class FakeMissionStore implements MissionStore {
  async get(): Promise<StoredMission | undefined> {
    return undefined;
  }
  async save(_p: string, mission: Mission, v: number): Promise<StoredMission> {
    return { mission, version: v + 1 };
  }
}
class FakeGit implements GitClient {
  commits: string[] = ["abc"];
  async isAvailable() {
    return true;
  }
  async clone(): Promise<void> {}
  async getDefaultBranch() {
    return "main";
  }
  async getHeadSha() {
    return "head";
  }
  async createBranch(): Promise<void> {}
  async branchExists(): Promise<boolean> {
    return false;
  }
  async checkoutBranch(): Promise<void> {}
  async getRepositoryIdentity(): Promise<RepositoryIdentity> {
    return { provider: "github", owner: "octocat", name: "hello-world" };
  }
  async collectChangesSince(): Promise<LocalChanges> {
    return {
      commits: [...this.commits],
      headSha: "head",
      filesChanged: [],
      insertions: 0,
      deletions: 0,
      workingTreeState: "CLEAN",
    };
  }
  async getCurrentBranch() {
    return "main";
  }
  async commitExists() {
    return true;
  }
}
class FakeJourneyStore implements JourneyStore {
  events: JourneyEvent[] = [];
  async append(e: JourneyEvent): Promise<void> {
    this.events.push(e);
  }
  async contains(): Promise<boolean> {
    return false;
  }
  async readAll(): Promise<JourneyEvent[]> {
    return [...this.events];
  }
}
class FakeJournal implements TransactionJournal {
  async create(): Promise<void> {}
  async advancePhase(): Promise<void> {}
  async get() {
    return undefined;
  }
  async listPending() {
    return [];
  }
  async remove(): Promise<void> {}
}
class NoopLock implements MissionLock {
  async withMissionLock<T>(
    _p: string,
    _m: MissionId,
    _o: string,
    action: () => Promise<T>,
  ): Promise<T> {
    return action();
  }
  async breakStaleLock(_p: string): Promise<void> {}
}
let counter = 0;
const idGenerator = {
  newMissionId: () => ("m" + ++counter) as MissionId,
  newChallengeId: () => ("c" + ++counter) as ChallengeId,
  newEventId: () => ("e" + ++counter) as EventId,
  newHandoffId: () => ("h" + ++counter) as HandoffId,
  newTransactionId: () => ("t" + ++counter) as TransactionId,
  newEvidenceId: () => ("ev" + ++counter) as EvidenceId,
};

function deps(
  gateway: FakeGateway,
  journeyStore: JourneyStore = new FakeJourneyStore(),
  git: GitClient = new FakeGit(),
) {
  return {
    lock: new NoopLock(),
    journal: new FakeJournal(),
    missionStore: new FakeMissionStore(),
    journeyStore,
    indexStore: new FakeIndexStore(),
    gateway,
    git,
    idGenerator,
    clock: { now: () => now },
  };
}

function input(mission: Mission, overrides: Record<string, unknown> = {}) {
  return {
    mission,
    sidecarPath: "/tmp/ws/m1/kestrel",
    lockPath: "/tmp/ws/m1/kestrel/.lock",
    expectedStateVersion: 0,
    token: "token",
    prNumber: 99,
    ...overrides,
  };
}

describe("verifySubmission", () => {
  it("records a valid submission", async () => {
    const journey = new FakeJourneyStore();
    const result = await verifySubmission(
      deps(new FakeGateway(), journey),
      input(inProgressMission()),
    );
    expect(result.kind).toBe("submitted");
    if (result.kind === "submitted") {
      expect(result.mission.submissionVerification).toBe("SUBMITTED");
    }
    expect(journey.events.some((e) => e.type === "PullRequestSubmitted")).toBe(true);
  });

  it("returns not-submitted for a wrong author", async () => {
    const gateway = new FakeGateway();
    gateway.pr = { ...gateway.pr, author: "someone-else" };
    const result = await verifySubmission(deps(gateway), input(inProgressMission()));
    expect(result.kind).toBe("not-submitted");
  });

  it("rejects caller-uncontrolled commits that do not match the mission work", async () => {
    const gateway = new FakeGateway();
    const git = new FakeGit();
    git.commits = ["unrelated-sha"]; // mission's actual local commits differ from the PR
    const result = await verifySubmission(
      deps(gateway, new FakeJourneyStore(), git),
      input(inProgressMission()),
    );
    expect(result.kind).toBe("not-submitted");
  });

  it("rejects a pull request from a different repository", async () => {
    const gateway = new FakeGateway();
    gateway.pr = {
      ...gateway.pr,
      repository: { provider: "github", owner: "other", name: "repo" },
    };
    const result = await verifySubmission(deps(gateway), input(inProgressMission()));
    expect(result.kind).toBe("not-submitted");
  });

  it("propagates a rate-limit error", async () => {
    const gateway = new FakeGateway();
    gateway.rateLimited = true;
    await expect(verifySubmission(deps(gateway), input(inProgressMission()))).rejects.toMatchObject(
      {
        code: "DM_GITHUB_RATE_LIMITED",
      },
    );
  });
});

describe("verifyIssueLink", () => {
  it("records a linked issue", async () => {
    const journey = new FakeJourneyStore();
    const mission = inProgressMission();
    const result = await verifyIssueLink(deps(new FakeGateway(), journey), {
      mission,
      sidecarPath: "/tmp/ws/m1/kestrel",
      lockPath: "/tmp/ws/m1/kestrel/.lock",
      expectedStateVersion: 0,
      token: "token",
      prNumber: 99,
    });
    expect(result.kind).toBe("linked");
    if (result.kind === "linked") {
      expect(result.mission.issueLink).toBeDefined();
    }
  });

  it("returns not-linked when there is no relationship", async () => {
    const gateway = new FakeGateway();
    gateway.link = undefined;
    const result = await verifyIssueLink(deps(gateway), {
      mission: inProgressMission(),
      sidecarPath: "/tmp/ws/m1/kestrel",
      lockPath: "/tmp/ws/m1/kestrel/.lock",
      expectedStateVersion: 0,
      token: "token",
      prNumber: 99,
    });
    expect(result.kind).toBe("not-linked");
  });

  it("rejects a link to an unrelated issue", async () => {
    const gateway = new FakeGateway();
    gateway.link = {
      issueNumber: 999,
      repository: { provider: "github", owner: "octocat", name: "hello-world" },
      relationship: "CLOSING_KEYWORD",
    };
    const result = await verifyIssueLink(deps(gateway), {
      mission: inProgressMission(),
      sidecarPath: "/tmp/ws/m1/kestrel",
      lockPath: "/tmp/ws/m1/kestrel/.lock",
      expectedStateVersion: 0,
      token: "token",
      prNumber: 99,
    });
    expect(result.kind).toBe("not-linked");
  });

  it("rejects a link from a different repository", async () => {
    const gateway = new FakeGateway();
    gateway.link = {
      issueNumber: 42,
      repository: { provider: "github", owner: "other", name: "repo" },
      relationship: "CLOSING_KEYWORD",
    };
    const result = await verifyIssueLink(deps(gateway), {
      mission: inProgressMission(),
      sidecarPath: "/tmp/ws/m1/kestrel",
      lockPath: "/tmp/ws/m1/kestrel/.lock",
      expectedStateVersion: 0,
      token: "token",
      prNumber: 99,
    });
    expect(result.kind).toBe("not-linked");
  });

  it("accepts provider-verified linkage to the mission issue", async () => {
    const gateway = new FakeGateway();
    gateway.link = {
      issueNumber: 42,
      repository: { provider: "github", owner: "octocat", name: "hello-world" },
      relationship: "PROVIDER_VERIFIED",
    };
    const result = await verifyIssueLink(deps(gateway), {
      mission: inProgressMission(),
      sidecarPath: "/tmp/ws/m1/kestrel",
      lockPath: "/tmp/ws/m1/kestrel/.lock",
      expectedStateVersion: 0,
      token: "token",
      prNumber: 99,
    });
    expect(result.kind).toBe("linked");
  });
});
