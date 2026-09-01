import { Box, Text } from "ink";
import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";
import {
  CommandRow,
  ContextActions,
  Dashboard,
  DashboardShell,
  DEFAULT_MISSION_SUGGESTIONS,
  DEFAULT_QUICK_COMMANDS,
  Footer,
  Header,
  isWideTerminal,
  MissionCard,
  navigationRowMarkers,
  NavItem,
  PromptLine,
  QuickCommands,
  SectionLabel,
  Sidebar,
  SmallStat,
  type TerminalCapabilities,
} from "./dashboard.js";
import type { SessionAction } from "./session-navigation.js";

const ENABLED_ACTION: SessionAction = {
  id: "find.run",
  label: "Find a challenge",
  command: "/find",
  availability: { status: "enabled" },
};

const DISABLED_ACTION: SessionAction = {
  id: "find.run",
  label: "Find a challenge",
  command: "/find",
  availability: {
    status: "disabled",
    reason: "GitHub auth is required",
    recoveryCommand: "/auth login",
  },
};

const wide: TerminalCapabilities = { columns: 80, rows: 24, color: true };
const narrowWidth: TerminalCapabilities = { columns: 59, rows: 24, color: true };
const narrowHeight: TerminalCapabilities = { columns: 80, rows: 19, color: true };
const narrowCombo: TerminalCapabilities = { columns: 44, rows: 24, color: true };

describe("isWideTerminal", () => {
  it("returns true at 80x24", () => {
    expect(isWideTerminal(wide)).toBe(true);
  });

  it("returns false at 59x24 (below 60 columns)", () => {
    expect(isWideTerminal(narrowWidth)).toBe(false);
  });

  it("returns false at 80x19 (below 20 rows)", () => {
    expect(isWideTerminal(narrowHeight)).toBe(false);
  });

  it("returns false at 44x24 (below 60 columns)", () => {
    expect(isWideTerminal(narrowCombo)).toBe(false);
  });
});

describe("navigationRowMarkers", () => {
  it("emits space-space-dash for an unfocused, unselected, enabled row", () => {
    expect(
      navigationRowMarkers({ focused: false, selected: false, availability: "enabled" }),
    ).toBe("  -");
  });

  it("emits space-star-dash for a selected-enabled row", () => {
    expect(
      navigationRowMarkers({ focused: false, selected: true, availability: "enabled" }),
    ).toBe(" *-");
  });

  it("emits greater-star-x for a focused-selected-disabled row (color independent)", () => {
    expect(
      navigationRowMarkers({ focused: true, selected: true, availability: "disabled" }),
    ).toBe(">*x");
  });

  it("emits greater-space-x for a focused-disabled row", () => {
    expect(
      navigationRowMarkers({ focused: true, selected: false, availability: "disabled" }),
    ).toBe("> x");
  });
});

describe("dashboard shell", () => {
  afterEach(() => cleanup());

  it("renders the header with status and subtitle", () => {
    const { lastFrame } = render(<Header status="Ready" />);
    expect(lastFrame()).toContain("KESTREL");
    expect(lastFrame()).toContain("Ready");
  });

  it("renders section labels in upper case", () => {
    const { lastFrame } = render(<SectionLabel label="actions" />);
    expect(lastFrame()).toContain("ACTIONS");
  });

  it("renders the mission card with title and description", () => {
    const { lastFrame } = render(
      <MissionCard
        title="No active mission"
        description="Discover a challenge or resume your current engineering work."
        suggestions={DEFAULT_MISSION_SUGGESTIONS}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("No active mission");
    expect(frame).toContain("Discover a challenge");
  });

  it("omits the suggestion row when there are no suggestions", () => {
    const { lastFrame } = render(
      <MissionCard title="Active" description="Working on it" suggestions={[]} />,
    );
    expect(lastFrame()).toContain("Active");
    expect(lastFrame()).not.toContain("/find");
  });

  it("renders a single command row with description", () => {
    const { lastFrame } = render(
      <CommandRow command="/find" description="Discover one recommended challenge" />,
    );
    expect(lastFrame()).toContain("/find");
    expect(lastFrame()).toContain("Discover one recommended challenge");
  });

  it("renders the quick commands panel from a list", () => {
    const { lastFrame } = render(<QuickCommands commands={DEFAULT_QUICK_COMMANDS} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("QUICK COMMANDS");
    expect(frame).toContain("/find");
    expect(frame).toContain("/mission current");
  });

  it("renders a small stat with title and detail", () => {
    const { lastFrame } = render(
      <SmallStat
        title="Progress"
        value="32%"
        detail="Overall journey completion"
        icon="▰"
        accent="green"
      />,
    );
    expect(lastFrame()).toContain("PROGRESS");
    expect(lastFrame()).toContain("32%");
    expect(lastFrame()).toContain("Overall journey completion");
  });

  it("renders the dashboard panels without an active mission", () => {
    const { lastFrame } = render(
      <Dashboard
        title="Mission Control"
        subtitle="Welcome back"
        sessionStatus="active"
        mission={{
          title: "No active mission",
          description: "Discover a challenge or resume your current engineering work.",
          suggestions: DEFAULT_MISSION_SUGGESTIONS,
        }}
        stats={[]}
        quickCommands={DEFAULT_QUICK_COMMANDS}
      />,
    );
    expect(lastFrame()).toContain("Mission Control");
    expect(lastFrame()).toContain("Welcome back");
    expect(lastFrame()).toContain("QUICK COMMANDS");
  });

  it("renders the prompt line with input or placeholder", () => {
    const empty = render(<PromptLine input="" busy={false} placeholder="Type a command…" />);
    expect(empty.lastFrame()).toContain("Type a command…");
    const typing = render(<PromptLine input="/find" busy={false} placeholder="Type…" />);
    expect(typing.lastFrame()).toContain("/find");
    expect(typing.lastFrame()).not.toContain("Type…");
    const busy = render(<PromptLine input="" busy={true} placeholder="Type…" />);
    expect(busy.lastFrame()).toContain("Working…");
    expect(busy.lastFrame()).toContain("Ctrl+C to cancel");
  });

  it("renders the footer with shortcuts", () => {
    const { lastFrame } = render(<Footer />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("KESTREL local");
    expect(frame).toContain("/help");
    expect(frame).toContain("/clear");
    expect(frame).toContain("/exit");
  });
  it("shows the sidebar with focus/selection markers", () => {
    const { lastFrame } = render(<Sidebar selectedIndex={0} capabilities={wide} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("NAVIGATE");
    expect(frame).toContain("Home");
    expect(frame).toContain("Find");
    expect(frame).toContain("Auth");
    expect(frame).toContain("Preferences");
    expect(frame).toContain("*");
  });

  it("renders a focused-selected-disabled nav item with the `>*x` markers", () => {
    const { lastFrame } = render(
      <Box>
        <NavItem icon="⌕" label="Find" focused selected availability="disabled" />
      </Box>,
    );
    expect(lastFrame()).toContain(">*x");
  });

  it("renders a selected-enabled nav item with `*-` markers", () => {
    const { lastFrame } = render(
      <Box>
        <NavItem icon="⌕" label="Find" selected availability="enabled" />
      </Box>,
    );
    expect(lastFrame()).toContain("*-");
  });
  it("renders a focused-disabled nav item with `> x` markers", () => {
    const { lastFrame } = render(
      <Box>
        <NavItem icon="⌕" label="Find" focused availability="disabled" />
      </Box>,
    );
    expect(lastFrame()).toContain("> x");
  });

  it("exposes focus/selection/availability markers even when color is disabled", () => {
    const noColor: TerminalCapabilities = { columns: 80, rows: 24, color: false };
    const { lastFrame } = render(
      <Box>
        <NavItem icon="⌕" label="Find" focused selected availability="disabled" colorize={false} />
      </Box>,
    );
    expect(lastFrame()).toContain(">*x");
    void noColor;
  });

  it("exposes `> x` for a focused-disabled row even when color is disabled", () => {
    const { lastFrame } = render(
      <Box>
        <NavItem icon="⌕" label="Find" focused availability="disabled" colorize={false} />
      </Box>,
    );
    expect(lastFrame()).toContain("> x");
  });

  it("exposes ` *-` for a selected-enabled row even when color is disabled", () => {
    const { lastFrame } = render(
      <Box>
        <NavItem icon="⌕" label="Find" selected availability="enabled" colorize={false} />
      </Box>,
    );
    expect(lastFrame()).toContain(" *-");
  });
});
describe("ContextActions", () => {
  afterEach(() => cleanup());

  it("renders an enabled action with command and `*-` marker when selected", () => {
    const { lastFrame } = render(
      <ContextActions actions={[ENABLED_ACTION]} selectedIndex={0} focused={true} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("ACTIONS");
    expect(frame).toContain("Find a challenge");
    expect(frame).toContain("/find");
    expect(frame).toContain("*-");
  });

  it("renders a disabled action with reason, recovery, and `> x` markers", () => {
    const { lastFrame } = render(
      <ContextActions actions={[DISABLED_ACTION]} selectedIndex={0} focused={true} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Find a challenge");
    expect(frame).toContain("GitHub auth is required");
    expect(frame).toContain("/auth login");
    expect(frame).toContain(">*x");
  });

  it("renders `> x` for a focused-disabled row even with color disabled", () => {
    const { lastFrame } = render(
      <ContextActions
        actions={[DISABLED_ACTION]}
        selectedIndex={0}
        focused={true}
        colorize={false}
      />,
    );
    expect(lastFrame()).toContain(">*x");
  });

  it("falls back to a placeholder when actions is empty", () => {
    const { lastFrame } = render(<ContextActions actions={[]} />);
    expect(lastFrame()).toContain("No actions available.");
  });
});

describe("DashboardShell responsive split", () => {
  afterEach(() => cleanup());

  it("keeps the shell renderable at 80x24", () => {
    const { lastFrame } = render(
      <DashboardShell
        status="Ready"
        title="Mission Control"
        subtitle="Welcome back"
        sessionStatus="active"
        mission={{
          title: "No active mission",
          description: "Discover a challenge or resume your current engineering work.",
          suggestions: DEFAULT_MISSION_SUGGESTIONS,
        }}
        stats={[]}
        quickCommands={DEFAULT_QUICK_COMMANDS}
        input=""
        busy={false}
        placeholder="Type a command…"
        capabilities={wide}
      >
        <Text>TRANSCRIPT_PLACEHOLDER</Text>
      </DashboardShell>,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("KESTREL");
    expect(frame).toContain("Ready");
    expect(frame).toContain("Mission Control");
    expect(frame).toContain("QUICK COMMANDS");
    expect(frame).toContain("Type a command…");
    expect(frame).toContain("TRANSCRIPT_PLACEHOLDER");
  });

  it("keeps the shell renderable at 59x24 (below 60)", () => {
    const { lastFrame } = render(
      <DashboardShell
        status="Ready"
        title="Mission Control"
        subtitle="Welcome back"
        sessionStatus="active"
        mission={{
          title: "No active mission",
          description: "Discover a challenge or resume your current engineering work.",
          suggestions: DEFAULT_MISSION_SUGGESTIONS,
        }}
        stats={[]}
        quickCommands={DEFAULT_QUICK_COMMANDS}
        input=""
        busy={false}
        placeholder="Type a command…"
        capabilities={narrowWidth}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Ready");
    expect(frame).toContain("Type a command…");
  });

  it("keeps the shell renderable at 80x19 (below 20 rows)", () => {
    const { lastFrame } = render(
      <DashboardShell
        status="Ready"
        title="Mission Control"
        subtitle="Welcome back"
        sessionStatus="active"
        mission={{
          title: "No active mission",
          description: "Discover a challenge or resume your current engineering work.",
          suggestions: DEFAULT_MISSION_SUGGESTIONS,
        }}
        stats={[]}
        quickCommands={DEFAULT_QUICK_COMMANDS}
        input=""
        busy={false}
        placeholder="Type a command…"
        capabilities={narrowHeight}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Ready");
    expect(frame).toContain("Type a command…");
  });

  it("keeps the shell renderable at 44x24 (compact)", () => {
    const { lastFrame } = render(
      <DashboardShell
        status="Ready"
        title="Mission Control"
        subtitle="Welcome back"
        sessionStatus="active"
        mission={{
          title: "No active mission",
          description: "Discover a challenge or resume your current engineering work.",
          suggestions: DEFAULT_MISSION_SUGGESTIONS,
        }}
        stats={[]}
        quickCommands={DEFAULT_QUICK_COMMANDS}
        input=""
        busy={false}
        placeholder="Type a command…"
        capabilities={narrowCombo}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Ready");
    expect(frame).toContain("Type a command…");
  });
});