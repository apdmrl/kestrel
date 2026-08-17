import { describe, expect, it } from "vitest";
import type { MissionId } from "../shared/identifiers.js";
import type { IsoDateTime } from "../shared/time.js";
import {
  createCommitEvidence,
  createIssueLinkEvidence,
  createLocalChangeEvidence,
  createMergeEvidence,
  createPullRequestEvidence,
  type EvidenceId,
} from "./evidence.js";

const missionId = "m1" as MissionId;
const observedAt = "2026-08-15T00:00:00Z" as IsoDateTime;

describe("evidence factories", () => {
  it("creates local change evidence", () => {
    const result = createLocalChangeEvidence({
      id: "e1" as EvidenceId,
      missionId,
      observedAt,
      baseCommit: "abc123",
      headCommit: "def456",
      commitsCreated: ["def456"],
      filesChanged: ["a.ts"],
      insertions: 3,
      deletions: 1,
      workingTreeState: "CLEAN",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("LOCAL_CHANGE");
      expect(result.value.filesChanged).toEqual(["a.ts"]);
    }
  });

  it("creates commit evidence", () => {
    const result = createCommitEvidence({
      id: "e2" as EvidenceId,
      missionId,
      observedAt,
      sha: "abc123",
      message: "fix crash",
      author: "dev",
      committedAt: observedAt,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("COMMIT");
      expect(result.value.sha).toBe("abc123");
    }
  });

  it("creates pull request evidence", () => {
    const result = createPullRequestEvidence({
      id: "e3" as EvidenceId,
      missionId,
      observedAt,
      number: 99,
      url: "https://github.com/o/n/pull/99",
      repository: { provider: "github", owner: "o", name: "n" },
      author: "dev",
      commits: ["abc123"],
      state: "OPEN",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("PULL_REQUEST");
      expect(result.value.number).toBe(99);
    }
  });

  it("creates issue link evidence", () => {
    const result = createIssueLinkEvidence({
      id: "e4" as EvidenceId,
      missionId,
      observedAt,
      issueNumber: 42,
      repository: { provider: "github", owner: "o", name: "n" },
      relationship: "CLOSING_KEYWORD",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("ISSUE_LINK");
      expect(result.value.relationship).toBe("CLOSING_KEYWORD");
    }
  });

  it("creates merge evidence with verified PR identity and merge SHA", () => {
    const result = createMergeEvidence({
      id: "e5" as EvidenceId,
      missionId,
      observedAt,
      pullRequestNumber: 99,
      repository: { provider: "github", owner: "o", name: "n" },
      mergeSha: "abc123",
      mergedAt: observedAt,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("MERGE");
      expect(result.value.mergeSha).toBe("abc123");
    }
  });

  it("rejects merge evidence without a merge SHA", () => {
    const result = createMergeEvidence({
      id: "e5" as EvidenceId,
      missionId,
      observedAt,
      pullRequestNumber: 99,
      repository: { provider: "github", owner: "o", name: "n" },
      mergeSha: "  ",
      mergedAt: observedAt,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects merge evidence with a non-positive PR number", () => {
    const result = createMergeEvidence({
      id: "e5" as EvidenceId,
      missionId,
      observedAt,
      pullRequestNumber: 0,
      repository: { provider: "github", owner: "o", name: "n" },
      mergeSha: "abc",
      mergedAt: observedAt,
    });
    expect(result.ok).toBe(false);
  });
});
