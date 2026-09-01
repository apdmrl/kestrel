import { describe, expect, it } from "vitest";
import type { RecommendationViewModel } from "../presentation/view-models.js";
import type { SessionAuthState } from "./session-state.js";
import { actionsForSection, NAVIGATION_SECTIONS } from "./session-navigation.js";

function recommendationView(
  overrides: Partial<RecommendationViewModel> = {},
): RecommendationViewModel {
  return {
    kind: "recommendation",
    recommendationId: "rec-1",
    challengeId: "ch-1",
    title: "Refactor the auth gateway",
    mood: "QUICK_WIN",
    confidence: 0.9,
    reasons: ["matches your recent merges"],
    ...overrides,
  };
}

describe("NAVIGATION_SECTIONS", () => {
  it("lists home first so HOME_SELECTED lands on the active category", () => {
    expect(NAVIGATION_SECTIONS[0]?.id).toBe("home");
  });

  it("carries category metadata only and exposes contextual actions", () => {
    const find = NAVIGATION_SECTIONS.find((section) => section.id === "find");
    expect(find).toBeDefined();
    expect(find?.label).toBe("Find");
    expect(find?.actions.length ?? 0).toBeGreaterThan(0);
    for (const action of find?.actions ?? []) {
      expect(action.command.startsWith("/")).toBe(true);
      expect(action.id.length).toBeGreaterThan(0);
    }
  });

  it("does not pin a fixed auth command into the static sidebar definition", () => {
    const auth = NAVIGATION_SECTIONS.find((section) => section.id === "auth");
    expect(auth).toBeDefined();
    // Auth actions are derived per auth state; the static list is empty.
    expect(auth?.actions).toEqual([]);
  });
});

describe("actionsForSection — auth", () => {
  const cases: ReadonlyArray<{
    readonly label: string;
    readonly state: SessionAuthState;
    readonly expectations: {
      readonly primaryId: string;
      readonly primaryCommand: string;
      readonly recoveryIds?: readonly string[];
    };
  }> = [
    {
      label: "checking",
      state: { status: "checking", attemptId: 1 },
      expectations: { primaryId: "auth.status", primaryCommand: "/auth status" },
    },
    {
      label: "required",
      state: { status: "required" },
      expectations: {
        primaryId: "auth.login",
        primaryCommand: "/auth login",
        recoveryIds: ["auth.status"],
      },
    },
    {
      label: "expired",
      state: { status: "expired" },
      expectations: {
        primaryId: "auth.login",
        primaryCommand: "/auth login",
        recoveryIds: ["auth.status"],
      },
    },
    {
      label: "unknown",
      state: { status: "unknown", errorCode: "DM_NETWORK_UNAVAILABLE" },
      expectations: {
        primaryId: "auth.status",
        primaryCommand: "/auth status",
        recoveryIds: ["auth.login"],
      },
    },
    {
      label: "connected",
      state: { status: "connected", login: "octocat" },
      expectations: { primaryId: "auth.status", primaryCommand: "/auth status" },
    },
    {
      label: "logging-in",
      state: { status: "logging-in", phase: "starting" },
      expectations: { primaryId: "auth.cancel", primaryCommand: "/auth cancel" },
    },
  ];

  for (const { label, state, expectations } of cases) {
    it(`adapts Auth actions for ${label}`, () => {
      const actions = actionsForSection("auth", state, null);
      const primary = actions.find((action) => action.id === expectations.primaryId);
      expect(primary?.command).toBe(expectations.primaryCommand);
      expect(primary?.availability.status).toBe("enabled");
      if (expectations.recoveryIds) {
        for (const id of expectations.recoveryIds) {
          const recovery = actions.find((action) => action.id === id);
          expect(recovery?.command).toMatch(/^\/auth /u);
          expect(recovery?.availability.status).toBe("enabled");
        }
      }
    });
  }
});

describe("actionsForSection — Find availability", () => {
  it("disables Find and exposes login recovery when auth is required", () => {
    const actions = actionsForSection("find", { status: "required" }, null);
    const find = actions.find((action) => action.id === "find.run");
    const login = actions.find((action) => action.id === "auth.login");
    expect(find?.availability).toMatchObject({ status: "disabled" });
    expect(typeof find?.availability?.reason).toBe("string");
    expect(find?.availability?.recoveryCommand).toBe("/auth login");
    expect(login).toEqual({
      id: "auth.login",
      label: expect.any(String),
      command: "/auth login",
      availability: { status: "enabled" },
    });
  });
  it("enables Find when auth is connected", () => {
    const actions = actionsForSection("find", { status: "connected", login: "octocat" }, null);
    const find = actions.find((action) => action.id === "find.run");
    expect(find?.command).toBe("/find");
    expect(find?.availability).toEqual({ status: "enabled" });
  });
  it("disables Find during unknown auth with /auth status recovery", () => {
    const actions = actionsForSection(
      "find",
      { status: "unknown", errorCode: "DM_NETWORK_UNAVAILABLE" },
      null,
    );
    const find = actions.find((action) => action.id === "find.run");
    const status = actions.find((action) => action.id === "auth.status");
    expect(find?.availability).toMatchObject({ status: "disabled" });
    expect(find?.availability?.recoveryCommand).toBe("/auth status");
    expect(status?.command).toBe("/auth status");
    expect(status?.availability).toEqual({ status: "enabled" });
  });
});

describe("actionsForSection — local categories", () => {
  it("keeps local progress enabled while auth is unknown", () => {
    expect(
      actionsForSection(
        "progress",
        { status: "unknown", errorCode: "DM_NETWORK_UNAVAILABLE" },
        null,
      )[0],
    ).toMatchObject({ command: "/progress", availability: { status: "enabled" } });
  });

  it("keeps local journey enabled while auth is required", () => {
    expect(actionsForSection("journey", { status: "required" }, null)[0]).toMatchObject({
      command: "/journey",
      availability: { status: "enabled" },
    });
  });
});

describe("actionsForSection — Mission accept", () => {
  it("derives exact acceptance from the displayed recommendation", () => {
    const recommendation = recommendationView({ recommendationId: "rec-42" });
    expect(
      actionsForSection("find", { status: "connected", login: "octocat" }, recommendation),
    ).toContainEqual(
      expect.objectContaining({
        id: "recommendation.accept",
        command: "/mission accept --id rec-42",
      }),
    );
  });

  it("omits the accept action without a recommendation", () => {
    const actions = actionsForSection("find", { status: "connected", login: "octocat" }, null);
    expect(actions.find((action) => action.id === "recommendation.accept")).toBeUndefined();
  });

  it("enables Mission actions when auth is connected", () => {
    const actions = actionsForSection("mission", { status: "connected", login: "octocat" }, null);
    expect(actions.find((action) => action.id === "mission.current")?.command).toBe(
      "/mission current",
    );
    expect(actions.find((action) => action.id === "mission.current")?.availability.status).toBe(
      "enabled",
    );
  });
});

describe("actionsForSection — unknown sections", () => {
  it("returns an empty list for an unknown section id", () => {
    expect(actionsForSection("nope", { status: "connected", login: "octocat" }, null)).toEqual([]);
  });
});