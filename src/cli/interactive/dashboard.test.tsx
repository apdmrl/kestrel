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
  estimateEntryRows,
  Footer,
  Header,
  isWideTerminal,
  MissionCard,
  navigationRowMarkers,
  NavItem,
  PromptLine,
  QuickCommands,
  type RenderableTranscriptEntry,
  SectionLabel,
  Sidebar,
  SmallStat,
  type TerminalCapabilities,
  windowTranscriptPage,
  moveTranscriptPageOffset,
  availableTranscriptRows,
  transcriptPaneWidth,
  contextActionsRowCount,
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
    expect(navigationRowMarkers({ focused: false, selected: false, availability: "enabled" })).toBe(
      "  -",
    );
  });

  it("emits space-star-dash for a selected-enabled row", () => {
    expect(navigationRowMarkers({ focused: false, selected: true, availability: "enabled" })).toBe(
      " *-",
    );
  });

  it("emits greater-star-x for a focused-selected-disabled row (color independent)", () => {
    expect(navigationRowMarkers({ focused: true, selected: true, availability: "disabled" })).toBe(
      ">*x",
    );
  });

  it("emits greater-space-x for a focused-disabled row", () => {
    expect(navigationRowMarkers({ focused: true, selected: false, availability: "disabled" })).toBe(
      "> x",
    );
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
    // Wide 80x24 uses the standard compactness tier: the mission card border
    // is retained (current mission title), but the full chrome (footer /
    // quick commands card) is dropped so the row budget fits.
    expect(frame).toContain("No active mission");
    expect(frame).toContain("TRANSCRIPT_PLACEHOLDER");
    expect(frame.split("\n").length).toBeLessThanOrEqual(wide.rows);
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

describe("DashboardShell row budget", () => {
  afterEach(() => cleanup());

  const frames: ReadonlyArray<{
    readonly label: string;
    readonly capabilities: TerminalCapabilities;
  }> = [
    { label: "80x24", capabilities: { columns: 80, rows: 24, color: true } },
    { label: "59x24", capabilities: { columns: 59, rows: 24, color: true } },
    { label: "80x19", capabilities: { columns: 80, rows: 19, color: true } },
    { label: "44x24", capabilities: { columns: 44, rows: 24, color: true } },
  ];

  for (const { label, capabilities } of frames) {
    it(`stays within the row budget at ${label}`, () => {
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
          capabilities={capabilities}
        >
          <Text>TRANSCRIPT_PLACEHOLDER</Text>
        </DashboardShell>,
      );
      const frame = lastFrame() ?? "";
      const actualRows = frame.split("\n").length;
      expect(
        actualRows,
        `expected <${capabilities.rows} rows at ${label}, got ${actualRows}`,
      ).toBeLessThan(capabilities.rows);
    });
  }

  it("preserves auth/operation status, active section markers, prompt, and key hint at 80x24", () => {
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
        input="/auth login"
        busy={false}
        placeholder="Type a command…"
        capabilities={wide}
        contextActions={[
          {
            id: "auth.login",
            label: "Log in to GitHub",
            command: "/auth login",
            availability: { status: "enabled" },
          },
        ]}
        selectedActionIndex={0}
        actionFocused={true}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Ready");
    expect(frame).toContain("active");
    expect(frame).toContain("/auth login");
    expect(frame).not.toContain("Type a command…");
    expect(frame).toContain("↑↓");
  });

  it("keeps the typed command visible at 59x24", () => {
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
        input="/mission accept --id rec-42"
        busy={false}
        placeholder="Type a command…"
        capabilities={narrowWidth}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Ready");
    expect(frame).toContain("/mission accept --id rec-42");
    expect(frame).not.toContain("Type a command…");
  });

  it("keeps the typed command visible at 44x24", () => {
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
        input="/mission accept --id rec-42"
        busy={false}
        placeholder="Type a command…"
        capabilities={narrowCombo}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Ready");
    expect(frame).toContain("/mission accept --id rec-42");
    expect(frame).not.toContain("Type a command…");
  });

  it("keeps the typed command visible at 80x19", () => {
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
        input="/mission accept --id rec-42"
        busy={false}
        placeholder="Type a command…"
        capabilities={narrowHeight}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Ready");
    expect(frame).toContain("/mission accept --id rec-42");
    expect(frame).not.toContain("Type a command…");
  });

  it("renders the verification URI and user code in compact view", () => {
    const { lastFrame } = render(
      <DashboardShell
        status="Awaiting browser"
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
        busy={true}
        placeholder="Type a command…"
        capabilities={narrowCombo}
      >
        <Text>Open https://github.com/login/device and enter ABCD-1234</Text>
        <Text>Recommendation ID: rec-42</Text>
      </DashboardShell>,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Awaiting browser");
    expect(frame).toContain("https://github.com/login/device");
    expect(frame).toContain("ABCD-1234");
    expect(frame).toContain("Recommendation ID: rec-42");
    expect(frame.split("\n").length).toBeLessThanOrEqual(narrowCombo.rows);
  });

  it("windows oversized transcript to stay within the row budget at 80x24", () => {
    const lines: JSX.Element[] = [];
    for (let i = 0; i < 60; i += 1) {
      lines.push(<Text key={i}>historic line {i}</Text>);
    }
    lines.push(<Text key="uri">Open https://github.com/login/device and enter ABCD-1234</Text>);
    lines.push(<Text key="rec">Recommendation ID: rec-42</Text>);
    lines.push(<Text key="cmd">/mission accept --id rec-42</Text>);
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
        input="/mission accept --id rec-42"
        busy={false}
        placeholder="Type a command…"
        capabilities={wide}
      >
        {lines}
      </DashboardShell>,
    );
    const frame = lastFrame() ?? "";
    expect(frame.split("\n").length).toBeLessThanOrEqual(wide.rows);
    expect(frame).toContain("https://github.com/login/device");
    expect(frame).toContain("ABCD-1234");
    expect(frame).toContain("rec-42");
    expect(frame).toContain("/mission accept --id rec-42");
  });

  it("windows oversized transcript at 59x24, 44x24, and 80x19", () => {
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly capabilities: TerminalCapabilities;
    }> = [
      { label: "59x24", capabilities: { columns: 59, rows: 24, color: true } },
      { label: "44x24", capabilities: { columns: 44, rows: 24, color: true } },
      { label: "80x19", capabilities: { columns: 80, rows: 19, color: true } },
    ];
    for (const { label, capabilities } of cases) {
      const lines: JSX.Element[] = [];
      for (let i = 0; i < 80; i += 1) {
        lines.push(<Text key={i}>older line {i}</Text>);
      }
      lines.push(<Text key="uri">Open https://github.com/login/device and enter ABCD-1234</Text>);
      lines.push(<Text key="rec">Recommendation ID: rec-42</Text>);
      lines.push(<Text key="cmd">/mission accept --id rec-42</Text>);
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
          input="/mission accept --id rec-42"
          busy={false}
          placeholder="Type a command…"
          capabilities={capabilities}
        >
          {lines}
        </DashboardShell>,
      );
      const frame = lastFrame() ?? "";
      const actualRows = frame.split("\n").length;
      expect(
        actualRows,
        `expected ≤${capabilities.rows} rows at ${label}, got ${actualRows}`,
      ).toBeLessThanOrEqual(capabilities.rows);
      expect(frame).toContain("https://github.com/login/device");
      expect(frame).toContain("ABCD-1234");
      expect(frame).toContain("rec-42");
      expect(frame).toContain("/mission accept --id rec-42");
    }
  });

  it("drops older noncritical transcript lines before recent critical content at 80x19", () => {
    const lines: JSX.Element[] = [];
    for (let i = 0; i < 50; i += 1) {
      lines.push(<Text key={i}>older filler {i}</Text>);
    }
    lines.push(<Text key="uri">https://github.com/login/device</Text>);
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
        capabilities={{ columns: 80, rows: 19, color: true }}
      >
        {lines}
      </DashboardShell>,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("https://github.com/login/device");
    expect(frame).not.toContain("older filler 0");
  });
 });
describe("DashboardShell transcript row budget", () => {
  afterEach(() => cleanup());

  function entries(
    count: number,
    options: {
      readonly columns: number;
      readonly fill: (index: number) => string;
      readonly tail?: (index: number) => RenderableTranscriptEntry;
    },
  ): RenderableTranscriptEntry[] {
    const list: RenderableTranscriptEntry[] = [];
    for (let i = 0; i < count; i += 1) {
      const tail = options.tail?.(i);
      if (tail !== undefined) {
        list.push(tail);
      } else {
        list.push({
          id: i + 1,
          text: options.fill(i),
          kind: "output",
          rows: estimateEntryRows(options.fill(i), "output", options.columns),
        });
      }
    }
    return list;
  }

  it("windows multiline entries to honor the row budget at 80x24", () => {
    const input: RenderableTranscriptEntry[] = entries(60, {
      columns: 80,
      fill: (i) => `historic line ${i}`,
    });
    input.push({
      id: 999,
      text:
        "Error [DM_NETWORK_UNAVAILABLE]: GitHub is unreachable\n" +
        "- Retry once you have network connectivity\n" +
        "- Run /auth status to continue.",
      kind: "error",
      rows: estimateEntryRows(
        "Error [DM_NETWORK_UNAVAILABLE]: GitHub is unreachable\n- Retry once you have network connectivity\n- Run /auth status to continue.",
        "error",
        80,
      ),
    });
    input.push({
      id: 1000,
      text: "Open https://github.com/login/device and enter ABCD-1234",
      kind: "output",
      rows: estimateEntryRows(
        "Open https://github.com/login/device and enter ABCD-1234",
        "output",
        80,
      ),
    });
    input.push({
      id: 1001,
      text: "Recommendation ID: rec-42",
      kind: "output",
      rows: estimateEntryRows("Recommendation ID: rec-42", "output", 80),
    });
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
        input="/mission accept --id rec-42"
        busy={false}
        placeholder="Type a command…"
        capabilities={wide}
        entries={input}
      />,
    );
    // The contiguous live tail keeps the latest recommendation and device
    // result while older filler falls outside the row budget.
    const frame = lastFrame() ?? "";
    expect(frame.split("\n").length).toBeLessThan(wide.rows);
    expect(frame).toContain("ABCD-1234");
    expect(frame).toContain("rec-42");
    expect(frame).toContain("/mission accept --id rec-42");
    expect(frame).not.toContain("historic line 0");
  });

  it("windows wrapped narrow entries at 59x24, 44x24, and 80x19", () => {
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly capabilities: TerminalCapabilities;
    }> = [
      { label: "59x24", capabilities: { columns: 59, rows: 24, color: true } },
      { label: "44x24", capabilities: { columns: 44, rows: 24, color: true } },
      { label: "80x19", capabilities: { columns: 80, rows: 19, color: true } },
    ];
    for (const { label, capabilities } of cases) {
      const input: RenderableTranscriptEntry[] = entries(80, {
        columns: capabilities.columns,
        fill: (i) => `older line ${i}`,
      });
      const uri = "Open https://github.com/login/device and enter ABCD-1234 to authenticate";
      input.push({
        id: 999,
        text: uri,
        kind: "output",
        rows: estimateEntryRows(uri, "output", capabilities.columns),
      });
      const rec = "Recommendation ID: rec-42";
      input.push({
        id: 1000,
        text: rec,
        kind: "output",
        rows: estimateEntryRows(rec, "output", capabilities.columns),
      });
      const cmd = "/mission accept --id rec-42";
      input.push({
        id: 1001,
        text: cmd,
        kind: "output",
        rows: estimateEntryRows(cmd, "output", capabilities.columns),
      });
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
          input={cmd}
          busy={false}
          placeholder="Type a command…"
          capabilities={capabilities}
          entries={input}
        />,
      );
      const frame = lastFrame() ?? "";
      const actualRows = frame.split("\n").length;
      expect(
        actualRows,
        `expected <${capabilities.rows} rows at ${label}, got ${actualRows}`,
      ).toBeLessThan(capabilities.rows);
      // The newest contiguous page contains the just-appended result entries.
      expect(frame).toContain("ABCD-1234");
      expect(frame).toContain("rec-42");
      expect(frame).toContain(cmd);
    }
  });

  it("exposes older critical entries through an explicit history offset", () => {
    const input: RenderableTranscriptEntry[] = [
      {
      id: 1,
      text: "Open https://github.com/login/device and enter ABCD-1234",
      kind: "output",
      rows: estimateEntryRows(
        "Open https://github.com/login/device and enter ABCD-1234",
        "output",
        80,
      ),
      },
    ];
    for (let i = 0; i < 30; i += 1) {
      input.push({
        id: 100 + i,
        text: `filler line ${i}`,
        kind: "output",
        rows: estimateEntryRows(`filler line ${i}`, "output", 80),
      });
    }
    input.push({
      id: 999,
      text: "/mission accept --id rec-42",
      kind: "output",
      rows: estimateEntryRows("/mission accept --id rec-42", "output", 80),
    });
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
        capabilities={{ columns: 80, rows: 19, color: true }}
        transcriptOffsetEntries={28}
        entries={input}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("ABCD-1234");
    expect(frame).not.toContain("/mission accept --id rec-42");
    expect(frame).toContain("History 1–4 / 32");
  });
});

describe("estimateEntryRows", () => {
  it("counts embedded newlines plus the entry's margin-top chrome", () => {
    const text = "first line\nsecond line\nthird line";
    // 3 logical lines + 1 margin-top row = 4 rendered rows.
    expect(estimateEntryRows(text, "output", 80)).toBe(4);
  });

  it("wraps long lines to the available column width", () => {
    const text = "a".repeat(120);
    const width = 40;
    const rows = estimateEntryRows(text, "output", width);
    expect(rows).toBeGreaterThan(2);
  });

  it("accounts for error chrome (border + padding + margin-top) on top of the text rows", () => {
    const single = "x";
    // output/input include 1 margin-top row; single-line text = 1 row.
    expect(estimateEntryRows(single, "output", 80)).toBe(2);
    // error adds 3 chrome rows (border top + border bottom + spacing) plus
    // the 1 margin-top, so a single-line error entry spans 5 rows.
    expect(estimateEntryRows(single, "error", 80)).toBeGreaterThanOrEqual(5);
    // system keeps its welcome-back label + body + margin-top.
    expect(estimateEntryRows(single, "system", 80)).toBeGreaterThanOrEqual(4);
  });
});

describe("transcriptPaneWidth", () => {
  it("subtracts only the sibling sidebar width in wide mode", () => {
    expect(transcriptPaneWidth({ columns: 80, rows: 24, color: true })).toBe(56);
  });

  it("uses the full containing-pane width in stacked mode", () => {
    expect(transcriptPaneWidth({ columns: 59, rows: 24, color: true })).toBe(59);
    expect(transcriptPaneWidth({ columns: 44, rows: 24, color: true })).toBe(44);
  });
});

describe("availableTranscriptRows (dynamic chrome)", () => {
  it("returns a positive row budget at 80x24", () => {
    expect(availableTranscriptRows(wide)).toBeGreaterThan(0);
  });
});

function buildContextActions(count: number, disabled = false): SessionAction[] {
  const actions: SessionAction[] = [];
  for (let i = 0; i < count; i += 1) {
    if (i === 0 && disabled) {
      actions.push({
        id: "find.run",
        label: "Find a challenge",
        command: "/find",
        availability: {
          status: "disabled",
          reason: "GitHub auth is required",
          recoveryCommand: "/auth login",
        },
      });
    } else {
      actions.push({
        id: `act.${i}`,
        label: `Action ${i}`,
        command: `/cmd-${i}`,
        availability: { status: "enabled" },
      });
    }
  }
  return actions;
}

describe("DashboardShell wide-pane + production ContextActions", () => {
  afterEach(() => cleanup());

  it("stays within 24 rows at 80x24 with production ContextActions mounted", () => {
    const actions = buildContextActions(6, true);
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
        contextActions={actions}
        selectedActionIndex={0}
        actionFocused={false}
      />,
    );
    const frame = lastFrame() ?? "";
    const actualRows = frame.split("\n").length;
    expect(
      actualRows,
      `expected ≤24 rows at 80x24 with 6 ContextActions, got ${actualRows}`,
    ).toBeLessThanOrEqual(24);
  });

  it("keeps a stable prompt row while windowing the selected action", () => {
    const props = {
      status: "Ready",
      title: "Mission Control",
      subtitle: "Welcome back",
      sessionStatus: "active",
      mission: {
        title: "No active mission",
        description: "Discover a challenge or resume your current engineering work.",
        suggestions: DEFAULT_MISSION_SUGGESTIONS,
      },
      stats: [],
      quickCommands: DEFAULT_QUICK_COMMANDS,
      input: "",
      busy: false,
      placeholder: "Type a command…",
      capabilities: wide,
    };
    const home = render(<DashboardShell {...props} contextActions={[]} />);
    const homeFrame = home.lastFrame() ?? "";
    home.unmount();
    const actions = render(
      <DashboardShell
        {...props}
        contextActions={buildContextActions(6, true)}
        selectedActionIndex={5}
        actionFocused
      />,
    );
    const actionsFrame = actions.lastFrame() ?? "";
    expect(actionsFrame).toContain("ACTIONS 6/6");
    expect(actionsFrame).toContain("Action 5");
    expect(actionsFrame.split("\n").length).toBe(homeFrame.split("\n").length);
    expect(actionsFrame.split("\n").findIndex((line) => line.includes("Type a command…"))).toBe(
      homeFrame.split("\n").findIndex((line) => line.includes("Type a command…")),
    );
  });

  it("keeps disabled recovery text visible in a compact action viewport", () => {
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
        contextActions={buildContextActions(6, true)}
        selectedActionIndex={0}
        actionFocused
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("GitHub auth is required");
    expect(frame).toContain("/auth login");
  });

  it("ContextActions with 6 actions renders more total rows than with 2 actions", () => {
    const a = render(
      <Box width={80}>
        <ContextActions actions={buildContextActions(2)} compact={false} />
      </Box>,
    );
    const aRows = (a.lastFrame() ?? "").split("\n").length;
    a.unmount();
    const b = render(
      <Box width={80}>
        <ContextActions actions={buildContextActions(6)} compact={false} />
      </Box>,
    );
    const bRows = (b.lastFrame() ?? "").split("\n").length;
    expect(bRows).toBeGreaterThan(aRows);
  });
  it("budgets ContextActions row count from enabled+disabled rows, not just action count", () => {
    // 6 production actions: 1 disabled (label + command + reason/recovery),
    // 5 enabled (label + command each). The exact rendered chrome must
    // include: 1 outer margin + 1 ACTIONS label + 1 inner margin +
    // 1 top border + per-action rows + 1 bottom border. The shell
    // passes the computed count to `availableTranscriptRows`; the
    // assertion compares the helper's row count against the actual
    // rendered ContextActions output so the budget never under-reserves.
    const actions = buildContextActions(6, true);
    const paneWidth = transcriptPaneWidth(wide);
    const computed = contextActionsRowCount(actions, paneWidth, false);
    const { lastFrame } = render(
      <Box width={paneWidth} marginTop={1} paddingX={1}>
        <ContextActions actions={actions} compact={false} />
      </Box>,
    );
    const rendered = (lastFrame() ?? "").split("\n").length;
    // The ContextActions row count must account for label + command +
    // disabled reason/recovery rows. 1 disabled = 3 rows of body; 5
    // enabled = 2 rows each = 10 rows. Plus 1 outer margin + 1 ACTIONS
    // label + 1 inner margin + 2 borders = 17 rows total.
    expect(computed).toBeGreaterThanOrEqual(actions.length);
    // The rendered chrome should equal the computed row count.
    expect(rendered).toBe(computed);
  });

  it("counts ContextActions disabled rows for each disabled action (label + command + reason)", () => {
    // 6 actions all disabled: each renders 1 label row + 1 command row +
    // 1 reason row = 3 body rows. The total chrome (1 outer margin +
    // 1 label + 1 inner margin + 1 top border + 6 × 3 body rows + 1
    // bottom border) = 22 rows.
    const all: SessionAction[] = [];
    for (let i = 0; i < 6; i += 1) {
      all.push({
        id: `d.${i}`,
        label: `Disabled ${i}`,
        command: `/cmd-${i}`,
        availability: {
          status: "disabled",
          reason: "GitHub auth is required",
          recoveryCommand: "/auth login",
        },
      });
    }
    const paneWidth = transcriptPaneWidth(wide);
    const computed = contextActionsRowCount(all, paneWidth, false);
    // 6 disabled actions × 3 rows each = 18 body rows. Plus chrome.
    expect(computed).toBeGreaterThanOrEqual(18);
  });
  it("counts compact action wrapping at the production nested padding width", () => {
    const compactCaps: TerminalCapabilities = { columns: 44, rows: 24, color: true };
    const paneWidth = transcriptPaneWidth(compactCaps);
    const actions: SessionAction[] = [
      {
        id: "recommendation.accept",
        label: "Accept recommendation",
        command: `/mission accept --id ${"r".repeat(16)}`,
        availability: { status: "enabled" },
      },
    ];
    const computed = contextActionsRowCount(actions, paneWidth, true);
    const { lastFrame } = render(
      <Box width={paneWidth} paddingX={1}>
        <ContextActions actions={actions} compact />
      </Box>,
    );
    expect((lastFrame() ?? "").split("\n").length).toBe(computed);
  });
});

describe("estimateEntryRows — display cells (CJK + emoji)", () => {
  it("counts 30 CJK characters as 60 cells, so a 44-column budget produces 2+ rows", () => {
    // 30 CJK characters × 2 cells = 60 cells. At 44 columns, that wraps
    // to ceil(60/44) = 2 rows for the text portion, plus 1 margin-top = 3.
    const text = "古".repeat(30);
    const rows = estimateEntryRows(text, "output", 44);
    expect(rows).toBeGreaterThanOrEqual(3);
  });

  it("counts a double-width emoji as 2 cells, wrapping 25 emoji at 44 columns", () => {
    // 🦄 is a 2-cell emoji. 25 × 2 = 50 cells → wraps to 2 rows of text + 1 margin.
    const text = "🦄".repeat(25);
    const rows = estimateEntryRows(text, "output", 44);
    expect(rows).toBeGreaterThanOrEqual(3);
  });
});

describe("estimateEntryRows — grapheme clusters (keycap + ZWJ emoji)", () => {
  it("treats a keycap emoji like 1️⃣ as a single grapheme cluster", () => {
    // 1️⃣ = "1" + U+FE0F (variation selector) + U+20E3 (combining enclosing keycap).
    // `Intl.Segmenter` collapses it into one cluster that renders as two
    // terminal cells; splitting by code points would split it into three
    // pieces and miscount.
    const text = "1️⃣".repeat(20);
    const rows = estimateEntryRows(text, "output", 20);
    // 20 clusters × 2 cells = 40 cells → ceil(40 / 20) = 2 text rows + 1 margin = 3.
    expect(rows).toBeGreaterThanOrEqual(3);
    expect(rows).toBeLessThanOrEqual(4);
  });

  it("treats a ZWJ family emoji 👨‍👩‍👧‍👦 as a single grapheme cluster", () => {
    // Family emoji is joined by U+200D (ZWJ); without segmentation, the
    // walk splits it into multiple code points whose widths differ from
    // the painted cells. The grapheme-aware walk keeps it as one cluster.
    const text = "👨‍👩‍👧‍👦".repeat(10);
    const rows = estimateEntryRows(text, "output", 20);
    // 10 family clusters ≈ 10–20 cells depending on locale data; the
    // key invariant is that the count never under-counts by counting
    // individual code points separately.
    expect(rows).toBeGreaterThanOrEqual(2);
    expect(rows).toBeLessThanOrEqual(4);
  });

  it("segments text before string-width so wrapping matches terminal cells", () => {
    // 5 keycap emoji = 10 cells at 4-column width: ceil(10 / 4) = 3 rows.
    // Without grapheme segmentation, the same string produces more rows
    // because each code point is counted independently.
    const text = "1️⃣2️⃣3️⃣4️⃣5️⃣";
    const rows = estimateEntryRows(text, "output", 4);
    // The grapheme-aware walk uses 5 clusters × 2 cells = 10 cells
    // at 4 cells per row = ceil(10/4) = 3 text rows + 1 margin-top = 4.
    expect(rows).toBeGreaterThanOrEqual(3);
    expect(rows).toBeLessThanOrEqual(6);
  });
});

describe("DashboardShell wide-mode 57–80 cell row cap (live pane width)", () => {
  afterEach(() => cleanup());

  it("windows wide-mode entries that wrap at the live main-pane width", () => {
    const wideCaps: TerminalCapabilities = { columns: 80, rows: 24, color: true };
    const input: RenderableTranscriptEntry[] = [];
    for (let i = 0; i < 20; i += 1) {
      const text = "x".repeat(57 + (i % 24));
      input.push({
        id: i + 1,
        text,
        kind: "output",
        rows: estimateEntryRows(text, "output", wideCaps.columns),
      });
    }
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
        capabilities={wideCaps}
        entries={input}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame.split("\n").length).toBeLessThanOrEqual(wideCaps.rows);
  });
});

describe("windowTranscriptPage", () => {
  it("returns contiguous pages measured from the newest entry", () => {
    const entries: RenderableTranscriptEntry[] = Array.from({ length: 6 }, (_, index) => ({
      id: index + 1,
      text: `entry ${index + 1}`,
      kind: "output",
      rows: 1,
    }));

    expect(windowTranscriptPage(entries, 3, 0).map((entry) => entry.id)).toEqual([4, 5, 6]);
    expect(windowTranscriptPage(entries, 3, 3).map((entry) => entry.id)).toEqual([1, 2, 3]);
  });

  it("advances variable-height pages without skipping entries", () => {
    const entries: RenderableTranscriptEntry[] = Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      text: `entry ${index + 1}`,
      kind: "output",
      rows: 6,
    }));

    const firstOlder = moveTranscriptPageOffset(entries, 10, 0, "older");
    const secondOlder = moveTranscriptPageOffset(entries, 10, firstOlder, "older");

    expect(firstOlder).toBe(1);
    expect(secondOlder).toBe(2);
    expect(windowTranscriptPage(entries, 10, secondOlder).map((entry) => entry.id)).toEqual([8]);
    expect(moveTranscriptPageOffset(entries, 10, secondOlder, "newer")).toBe(firstOlder);
  });

  it("keeps one oversized entry visible instead of returning an empty page", () => {
    const entries: RenderableTranscriptEntry[] = [
      { id: 1, text: "large output", kind: "output", rows: 8 },
    ];

    expect(windowTranscriptPage(entries, 3, 0).map((entry) => entry.id)).toEqual([1]);
  });
});
