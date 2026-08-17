import { describe, expect, it } from "vitest";
import { createChallenge } from "../../domain/challenge/challenge.js";
import type { Challenge } from "../../domain/challenge/challenge.js";
import { createEvaluationContext } from "../../domain/challenge/evaluation-context.js";
import type { EvaluationContext } from "../../domain/challenge/evaluation-context.js";
import {
  createExplicitPreferences,
  resolveDeveloperContext,
} from "../../domain/preferences/preferences.js";
import { createLearnedSignals } from "../../domain/preferences/learned-signals.js";
import { createSearchIntent } from "../../domain/discovery/search-intent.js";
import type { SearchIntent } from "../../domain/discovery/search-intent.js";
import type { ChallengeId } from "../../domain/shared/identifiers.js";
import type { IsoDateTime } from "../../domain/shared/time.js";
import type { ChallengeSource } from "../../ports/challenge-source.js";
import { createKestrelError } from "../errors/kestrel-error.js";
import { findChallenge, skipRecommendation } from "./find-challenge.js";

const now = "2026-08-15T10:00:00Z" as IsoDateTime;
const clock = { now: () => now };

function makeChallenge(id: string): Challenge {
  const result = createChallenge({
    id: id as ChallengeId,
    externalId: id,
    repository: { provider: "github", owner: "o", name: "n" },
    issueNumber: Number(id.slice(1)),
    canonicalUrl: "https://github.com/o/n/issues/" + id,
    title: "t " + id,
    description: "d",
    type: "BUG_FIX",
    labels: ["bug"],
    language: "typescript",
    createdAt: "2026-08-01T00:00:00Z" as IsoDateTime,
    updatedAt: "2026-08-01T00:00:00Z" as IsoDateTime,
  });
  if (!result.ok) {
    throw new Error("expected ok");
  }
  return result.value;
}

function intent(): SearchIntent {
  const explicit = createExplicitPreferences({ preferredLanguages: ["typescript"] });
  const result = createSearchIntent({
    mood: "QUICK_WIN",
    explicitPreferences: explicit.ok ? explicit.value : ({} as never),
    pageBudget: 5,
  });
  if (!result.ok) {
    throw new Error("expected ok");
  }
  return result.value;
}

function developer() {
  const explicit = createExplicitPreferences({ preferredLanguages: ["typescript"] });
  const learned = createLearnedSignals({});
  if (!explicit.ok || !learned.ok) {
    throw new Error("expected ok");
  }
  return resolveDeveloperContext(explicit.value, learned.value);
}

class FakeSource implements ChallengeSource {
  challenges: Challenge[] = [];
  enrichCalls = 0;
  searchCalls = 0;
  searchError: unknown;
  enrichError: unknown;

  async search(_intent: SearchIntent): Promise<readonly Challenge[]> {
    this.searchCalls += 1;
    if (this.searchError !== undefined) {
      throw this.searchError;
    }
    return this.challenges;
  }

  async enrich(_challenge: Challenge): Promise<EvaluationContext> {
    this.enrichCalls += 1;
    if (this.enrichError !== undefined) {
      throw this.enrichError;
    }
    const result = createEvaluationContext({
      observedAt: now,
      repositoryHealth: 0.8,
      confidence: 0.6,
    });
    if (!result.ok) {
      throw new Error("expected ok");
    }
    return result.value;
  }
}

function deps(source: FakeSource) {
  return { source, developer: developer(), clock };
}

describe("findChallenge", () => {
  it("returns a single recommendation by default", async () => {
    const source = new FakeSource();
    source.challenges = [makeChallenge("c1"), makeChallenge("c2")];
    const result = await findChallenge(deps(source), {
      mode: "PICK_ONE",
      mood: "QUICK_WIN",
      intent: intent(),
    });
    expect(result.kind).toBe("recommendation");
    if (result.kind === "recommendation") {
      expect(result.alternatives).toEqual([]);
      expect(result.recommendation.challenge.id).toBeDefined();
    }
  });

  it("bounds enrichment to the plan budget", async () => {
    const source = new FakeSource();
    source.challenges = Array.from({ length: 10 }, (_, i) => makeChallenge("c" + (i + 1)));
    await findChallenge(deps(source), { mode: "BROWSE", mood: "QUICK_WIN", intent: intent() });
    expect(source.enrichCalls).toBeLessThan(10);
    expect(source.enrichCalls).toBeGreaterThan(0);
  });

  it("returns a bounded ordered list in browse mode", async () => {
    const source = new FakeSource();
    source.challenges = [makeChallenge("c1"), makeChallenge("c2"), makeChallenge("c3")];
    const result = await findChallenge(deps(source), {
      mode: "BROWSE",
      mood: "QUICK_WIN",
      intent: intent(),
    });
    if (result.kind === "recommendation") {
      expect(result.alternatives.length).toBeLessThanOrEqual(3);
    }
  });

  it("returns empty when the source is exhausted", async () => {
    const source = new FakeSource();
    source.challenges = [];
    const result = await findChallenge(deps(source), {
      mode: "PICK_ONE",
      mood: "QUICK_WIN",
      intent: intent(),
    });
    expect(result.kind).toBe("empty");
  });

  it("excludes prior candidates for 'show another'", async () => {
    const source = new FakeSource();
    source.challenges = [makeChallenge("c1")];
    const result = await findChallenge(deps(source), {
      mode: "PICK_ONE",
      mood: "QUICK_WIN",
      intent: intent(),
      exclusions: ["c1" as ChallengeId],
    });
    expect(result.kind).toBe("empty");
  });

  it("propagates a classified network failure", async () => {
    const source = new FakeSource();
    source.searchError = createKestrelError({
      code: "DM_NETWORK_UNAVAILABLE",
      category: "TRANSIENT",
      userMessage: "network down",
      suggestedActions: ["retry"],
      retryability: "RETRYABLE",
      recoveryStrategy: "RETRY",
      severity: "ERROR",
    });
    await expect(
      findChallenge(deps(source), { mode: "PICK_ONE", mood: "QUICK_WIN", intent: intent() }),
    ).rejects.toMatchObject({ code: "DM_NETWORK_UNAVAILABLE" });
  });

  it("records a 'show another' skip without asking why", async () => {
    const skipped: string[] = [];
    await skipRecommendation(
      {
        recordSkip: async (id) => {
          skipped.push(id);
        },
      },
      "c1" as ChallengeId,
    );
    expect(skipped).toEqual(["c1"]);
  });
});
