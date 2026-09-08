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
    description: "Issue details",
    repository: "octocat/hello-world",
    issueNumber: 42,
    issueUrl: "https://github.com/octocat/hello-world/issues/42",
    challengeType: "BUG_FIX",
    language: "TypeScript",
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
      readonly primaryDisabled?: boolean;
      readonly recoveryIds?: readonly string[];
    };
  }> = [
    {
      label: "checking",
      state: { status: "checking", attemptId: 1 },
      expectations: {
        primaryId: "auth.status",
        primaryCommand: "/auth status",
        primaryDisabled: true,
      },
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
      expectations: {
        primaryId: "auth.cancel-instruction",
        primaryCommand: "",
        primaryDisabled: true,
      },
    },
  ];

  for (const { label, state, expectations } of cases) {
    it(`adapts Auth actions for ${label}`, () => {
      const actions = actionsForSection("auth", state, null);
      const primary = actions.find((action) => action.id === expectations.primaryId);
      expect(primary?.command).toBe(expectations.primaryCommand);
      const expectedStatus = expectations.primaryDisabled === true ? "disabled" : "enabled";
      expect(primary?.availability.status).toBe(expectedStatus);
      if (expectations.recoveryIds) {
        for (const id of expectations.recoveryIds) {
          const recovery = actions.find((action) => action.id === id);
          expect(recovery?.command).toMatch(/^\/auth /u);
          expect(recovery?.availability.status).toBe("enabled");
        }
      }
    });
   }

  it("surfaces logging-in cancellation as a disabled, non-routable instruction", () => {
    const actions = actionsForSection("auth", { status: "logging-in", phase: "starting" }, null);
    const cancel = actions.find((action) => action.id === "auth.cancel-instruction");
    expect(cancel, "expected logging-in cancel instruction").toBeDefined();
    // The slash command must not be routable while the device flow is in flight.
    expect(cancel?.command).toBe("");
    expect(cancel?.availability.status).toBe("disabled");
    // The session must never advertise `/auth cancel` as an enabled action.
    expect(actions.find((action) => action.command === "/auth cancel")).toBeUndefined();
  });
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

  it("disables Find during checking auth with /auth status recovery", () => {
    const actions = actionsForSection("find", { status: "checking", attemptId: 1 }, null);
    const find = actions.find((action) => action.id === "find.run");
    const status = actions.find((action) => action.id === "auth.status");
    expect(find?.availability).toMatchObject({ status: "disabled" });
    expect(find?.availability?.recoveryCommand).toBe("/auth status");
    expect(status?.command).toBe("/auth status");
  });

  it("disables Verify during checking auth with /auth status recovery", () => {
    const actions = actionsForSection("verify", { status: "checking", attemptId: 1 }, null);
    const recovery = actions.find(
      (action) => action.id === "auth.status" || action.id === "auth.login",
    );
    expect(recovery, "expected recovery action for verify").toBeDefined();
    expect(recovery?.command).toBe("/auth status");
    // Every Verify base action is disabled with /auth status recovery.
    const disabledActions = actions.filter((action) => action.availability.status === "disabled");
    expect(disabledActions.length, "expected disabled actions for verify").toBeGreaterThan(0);
    for (const action of disabledActions) {
      if (action.availability.status !== "disabled") continue;
      expect(action.availability.recoveryCommand).toBe("/auth status");
    }
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
describe("actionsForSection — local Mission and Agent availability", () => {
  // Mission and Agent are local-first sections: their slash commands operate
  // on the mission sidecar and the journey index, and never call into GitHub.
  // They must stay enabled across every non-connected auth state so a developer
  // can keep recording evidence while offline, while the credentials are still
  // being verified, or while the stored token has expired.
  const DISCONNECTED_STATES: ReadonlyArray<{
    readonly label: string;
    readonly state: SessionAuthState;
  }> = [
    { label: "required", state: { status: "required" } },
    { label: "expired", state: { status: "expired" } },
    { label: "checking", state: { status: "checking", attemptId: 1 } },
    {
      label: "unknown",
      state: { status: "unknown", errorCode: "DM_NETWORK_UNAVAILABLE" },
    },
  ];

  it("keeps every local Mission action enabled for each disconnected auth state", () => {
    const expectedCommands: Readonly<Record<string, string>> = {
      "mission.current": "/mission current",
      "mission.accept": "/mission accept --id ",
      "mission.prepare": "/mission prepare",
      "mission.resume": "/mission resume",
      "mission.complete": "/mission complete",
      "mission.abandon": "/mission abandon --reason ",
    };
    for (const { state } of DISCONNECTED_STATES) {
      const actions = actionsForSection("mission", state, null);
      for (const [id, command] of Object.entries(expectedCommands)) {
        const action = actions.find((entry) => entry.id === id);
        expect(action, `${id} must surface under Mission for ${state.status}`).toBeDefined();
        expect(action?.command).toBe(command);
        expect(action?.availability, `${id} must be enabled for ${state.status}`).toEqual({
          status: "enabled",
        });
      }
      // No GitHub recovery action is ever appended to a local Mission list.
      expect(actions.find((entry) => entry.id === "auth.login")).toBeUndefined();
      expect(actions.find((entry) => entry.id === "auth.status")).toBeUndefined();
    }
  });

  it("keeps the Agent /agent brief action enabled for each disconnected auth state", () => {
    for (const { state } of DISCONNECTED_STATES) {
      const actions = actionsForSection("agent", state, null);
      const brief = actions.find((entry) => entry.id === "agent.brief");
      expect(brief, `/agent brief must surface for ${state.status}`).toBeDefined();
      expect(brief?.command).toBe("/agent brief");
      expect(brief?.availability, `/agent brief must be enabled for ${state.status}`).toEqual({
        status: "enabled",
      });
      // No GitHub recovery action is ever appended to a local Agent list.
      expect(actions.find((entry) => entry.id === "auth.login")).toBeUndefined();
      expect(actions.find((entry) => entry.id === "auth.status")).toBeUndefined();
    }
  });

  it("does not classify Mission or Agent as GitHub-dependent in the sidebar", () => {
    const mission = NAVIGATION_SECTIONS.find((section) => section.id === "mission");
    const agent = NAVIGATION_SECTIONS.find((section) => section.id === "agent");
    expect(mission?.requires).toBeUndefined();
    expect(agent?.requires).toBeUndefined();
  });

  it("keeps Find gated for each disconnected auth state with the right recovery", () => {
    for (const { state } of DISCONNECTED_STATES) {
      const actions = actionsForSection("find", state, null);
      const find = actions.find((entry) => entry.id === "find.run");
      expect(find?.availability).toMatchObject({ status: "disabled" });
      const recoveryId =
        state.status === "checking" || state.status === "unknown" ? "auth.status" : "auth.login";
      const recovery = actions.find((entry) => entry.id === recoveryId);
      expect(recovery?.availability).toEqual({ status: "enabled" });
    }
  });

  it("keeps Verify gated for each disconnected auth state with the right recovery", () => {
    for (const { state } of DISCONNECTED_STATES) {
      const actions = actionsForSection("verify", state, null);
      for (const id of ["verify.submission", "verify.link", "verify.merge"]) {
        const action = actions.find((entry) => entry.id === id);
        expect(action?.availability, `${id} must stay disabled for ${state.status}`).toMatchObject({
          status: "disabled",
        });
      }
      const recoveryId =
        state.status === "checking" || state.status === "unknown" ? "auth.status" : "auth.login";
      const recovery = actions.find((entry) => entry.id === recoveryId);
      expect(recovery?.availability).toEqual({ status: "enabled" });
    }
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