import type { RecommendationViewModel } from "../presentation/view-models.js";
import type { SessionAuthState } from "./session-state.js";

/**
 * Authoritative session-auth state is owned by `session-state.ts`; this module
 * only reads it. The interactive session consumes auth here to decide whether
 * GitHub-dependent commands may be invoked, and the application credential
 * guard remains authoritative when a command is typed manually, pasted, or
 * invoked through the plain CLI.
 */

export type SessionSectionId =
  | "home"
  | "find"
  | "mission"
  | "agent"
  | "verify"
  | "progress"
  | "journey"
  | "auth"
  | "preferences";

export interface SessionAction {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly availability: ActionAvailability;
}

export type ActionAvailability =
  | { readonly status: "enabled" }
  | { readonly status: "disabled"; readonly reason: string; readonly recoveryCommand?: string };

export interface NavigationSection {
  readonly id: SessionSectionId;
  readonly label: string;
  readonly requires?: "github";
  readonly actions: readonly SessionAction[];
}

const ENABLED: ActionAvailability = { status: "enabled" };

/**
 * Static template actions per category.
 *
 * Each action carries the slash command it represents; the prompt is filled
 * verbatim so a second Enter submits it. Auth actions are derived per
 * `SessionAuthState` (see `actionsForSection`), so the Auth entry here is
 * intentionally empty.
 */
const SECTION_ACTIONS: Readonly<Record<SessionSectionId, readonly SessionAction[]>> = {
  home: [],
  find: [
    {
      id: "find.run",
      label: "Find a challenge",
      command: "/find",
      availability: ENABLED,
    },
  ],
  mission: [
    {
      id: "mission.current",
      label: "Current mission",
      command: "/mission current",
      availability: ENABLED,
    },
    {
      id: "mission.accept",
      label: "Accept recommendation",
      command: "/mission accept --id ",
      availability: ENABLED,
    },
    {
      id: "mission.prepare",
      label: "Prepare mission",
      command: "/mission prepare",
      availability: ENABLED,
    },
    {
      id: "mission.resume",
      label: "Resume preparation",
      command: "/mission resume",
      availability: ENABLED,
    },
    {
      id: "mission.complete",
      label: "Complete mission",
      command: "/mission complete",
      availability: ENABLED,
    },
    {
      id: "mission.abandon",
      label: "Abandon mission",
      command: "/mission abandon --reason ",
      availability: ENABLED,
    },
  ],
  agent: [
    {
      id: "agent.brief",
      label: "Create handoff",
      command: "/agent brief",
      availability: ENABLED,
    },
  ],
  verify: [
    {
      id: "verify.submission",
      label: "Verify submission",
      command: "/verify submission --pr ",
      availability: ENABLED,
    },
    {
      id: "verify.link",
      label: "Verify issue link",
      command: "/verify link --pr ",
      availability: ENABLED,
    },
    {
      id: "verify.merge",
      label: "Verify merge",
      command: "/verify merge --pr ",
      availability: ENABLED,
    },
  ],
  progress: [
    {
      id: "progress.show",
      label: "Show progress",
      command: "/progress",
      availability: ENABLED,
    },
  ],
  journey: [
    {
      id: "journey.show",
      label: "Show journey",
      command: "/journey",
      availability: ENABLED,
    },
  ],
  auth: [],
  preferences: [
    {
      id: "preferences.get",
      label: "Show preferences",
      command: "/preferences get",
      availability: ENABLED,
    },
    {
      id: "preferences.language",
      label: "Set language",
      command: "/preferences set --language ",
      availability: ENABLED,
    },
    {
      id: "preferences.mode",
      label: "Set mode",
      command: "/preferences set --mode ",
      availability: ENABLED,
    },
  ],
};

const SECTION_LABELS: Readonly<
  Record<SessionSectionId, { readonly label: string; readonly requires?: "github" }>
> = {
  home: { label: "Home" },
  find: { label: "Find", requires: "github" },
  mission: { label: "Mission", requires: "github" },
  agent: { label: "Agent", requires: "github" },
  verify: { label: "Verify", requires: "github" },
  progress: { label: "Progress" },
  journey: { label: "Journey" },
  auth: { label: "Auth" },
  preferences: { label: "Preferences" },
};

const SECTION_ORDER: readonly SessionSectionId[] = [
  "home",
  "find",
  "mission",
  "agent",
  "verify",
  "progress",
  "journey",
  "auth",
  "preferences",
];

/**
 * Sidebar definition in render order. Home sits at index 0 so a reducer's
 * `HOME_SELECTED` lands on the active category and the navigation wraps
 * cleanly through every category.
 */
export const NAVIGATION_SECTIONS: readonly NavigationSection[] = SECTION_ORDER.map((id) => {
  const meta = SECTION_LABELS[id];
  return {
    id,
    label: meta.label,
    ...(meta.requires === undefined ? {} : { requires: meta.requires }),
    actions: SECTION_ACTIONS[id],
  } satisfies NavigationSection;
});

const GITHUB_NOT_VERIFIED_REASON =
  "GitHub authentication is not verified. Run the recovery command to enable this action.";

function disabled(reason: string, recoveryCommand?: string): ActionAvailability {
  return recoveryCommand === undefined
    ? { status: "disabled", reason }
    : { status: "disabled", reason, recoveryCommand };
}

function authActions(auth: SessionAuthState): readonly SessionAction[] {
  switch (auth.status) {
    case "checking":
      return [
        {
          id: "auth.status",
          label: "Check authentication",
          command: "/auth status",
          availability: ENABLED,
        },
      ];
    case "required":
      return [
        {
          id: "auth.login",
          label: "Log in to GitHub",
          command: "/auth login",
          availability: ENABLED,
        },
        {
          id: "auth.status",
          label: "Check authentication",
          command: "/auth status",
          availability: ENABLED,
        },
      ];
    case "expired":
      return [
        {
          id: "auth.login",
          label: "Re-authenticate GitHub",
          command: "/auth login",
          availability: ENABLED,
        },
        {
          id: "auth.status",
          label: "Check authentication",
          command: "/auth status",
          availability: ENABLED,
        },
      ];
    case "unknown":
      return [
        {
          id: "auth.status",
          label: "Check authentication",
          command: "/auth status",
          availability: ENABLED,
        },
        {
          id: "auth.login",
          label: "Log in to GitHub",
          command: "/auth login",
          availability: ENABLED,
        },
      ];
    case "connected":
      return [
        {
          id: "auth.status",
          label: "Check authentication",
          command: "/auth status",
          availability: ENABLED,
        },
        {
          id: "auth.logout",
          label: "Log out",
          command: "/auth logout --confirm github.com",
          availability: ENABLED,
        },
      ];
    case "logging-in":
      // Behaviour (cancel the in-flight login) is owned by Task 5: pressing
      // Ctrl+C during the device-flow must abort the login child and restore
      // the prior auth state. Until that runtime lands, surface the
      // instruction as a disabled, non-routable action so the sidebar never
      // emits an unrouteable `/auth cancel` slash command.
      return [
        {
          id: "auth.cancel-instruction",
          label: "Cancel login (Ctrl+C)",
          command: "",
          availability: {
            status: "disabled",
            reason: "Press Ctrl+C to cancel the in-flight login. Slash command is not available.",
          },
        },
      ];
  }
}

function deriveGitHubActions(
  base: readonly SessionAction[],
  auth: SessionAuthState,
): readonly SessionAction[] {
  if (auth.status === "connected") return base;
  // `checking` and `unknown` both surface `/auth status`: while the session
  // is still verifying the credential the recovery is "check first"; only
  // `required`, `expired`, and `logging-in` mean "log in now".
  const recoveryCommand =
    auth.status === "unknown" || auth.status === "checking" ? "/auth status" : "/auth login";
  const loginLabel =
    auth.status === "expired" ? "Re-authenticate GitHub" : "Log in to GitHub";
  return [
    ...base.map((action) => ({
      ...action,
      availability: disabled(GITHUB_NOT_VERIFIED_REASON, recoveryCommand),
    })),
    {
      id: recoveryCommand === "/auth login" ? "auth.login" : "auth.status",
      label: recoveryCommand === "/auth login" ? loginLabel : "Check authentication",
      command: recoveryCommand,
      availability: ENABLED,
    },
  ];
}
function withAcceptAction(
  base: readonly SessionAction[],
  recommendation: RecommendationViewModel | null,
): readonly SessionAction[] {
  if (recommendation === null) return base;
  return [
    ...base,
    {
      id: "recommendation.accept",
      label: "Accept recommendation",
      command: `/mission accept --id ${recommendation.recommendationId}`,
      availability: ENABLED,
    },
  ];
}

/**
 * Resolve the contextual actions for a sidebar category against the current
 * auth state and any displayed recommendation. GitHub-dependent categories
 * are disabled with the right recovery command while auth is not verified;
 * local categories remain enabled regardless of auth.
 */
export function actionsForSection(
  sectionId: string,
  auth: SessionAuthState,
  latestRecommendation: RecommendationViewModel | null,
): readonly SessionAction[] {
  const section = NAVIGATION_SECTIONS.find((entry) => entry.id === sectionId);
  if (section === undefined) return [];
  if (section.id === "auth") return authActions(auth);

  const baseActions = SECTION_ACTIONS[section.id];
  const withAccept =
    section.id === "find" ? withAcceptAction(baseActions, latestRecommendation) : baseActions;
  return section.requires === "github" ? deriveGitHubActions(withAccept, auth) : withAccept;
}