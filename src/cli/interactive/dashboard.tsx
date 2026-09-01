import { Children } from "react";
import type { ReactNode } from "react";
import { Box, Text } from "ink";
import { NAVIGATION_SECTIONS } from "./session-navigation.js";
import type { SessionAction } from "./session-navigation.js";

/**
 * Kestrel TUI — presentation shell.
 *
 * Pure rendering components. The shell is wired into the interactive session
 * by `Session` (see ./session.tsx); this file owns no input, navigation, or
 * command-routing logic.
 *
 * Sections, in render order (compact tiers may omit chrome — see
 * `compactnessTier`):
 *  - Header           KESTREL / LOCAL WORKSPACE status
 *  - Sidebar          category navigation with focus / selection / enable markers
 *  - ContextActions   contextual actions for the active category
 *  - MissionCard      optional mission chrome (full / standard tiers only)
 *  - QuickCommands    optional quick commands chrome (full / standard tiers only)
 *  - Children         session transcript / result content
 *  - PromptLine       active input prompt
 *
 * The shell honours the actual `rows` budget of the supplied
 * `TerminalCapabilities`. The wide layout (sidebar next to main) is reserved
 * for `wide`-class terminals; everything else stacks vertically. The compact
 * tiers drop mission-card / quick-commands chrome so the auth/operation
 * status, sidebar markers, action panel, prompt, key hint, and full
 * representative strings (verification URI, user code, recommendation ID,
 * typed command) fit within `capabilities.rows`.
 */

const COLORS = {
  border: "gray",
  borderSoft: "gray",
  muted: "gray",
  text: "white",
  red: "red",
  green: "green",
  cyan: "cyan",
  yellow: "yellow",
  purple: "magenta",
} as const;

export type Accent = "green" | "cyan" | "yellow" | "purple" | "red";

export interface TerminalCapabilities {
  readonly columns: number;
  readonly rows: number;
  readonly color: boolean;
}

const DEFAULT_TERMINAL_CAPABILITIES: TerminalCapabilities = {
  columns: 80,
  rows: 24,
  color: true,
};

export function isWideTerminal(caps: TerminalCapabilities): boolean {
  return caps.columns >= 60 && caps.rows >= 20;
}

/**
 * Compactness tier derived from the row budget and column budget. The tier
 * determines which chrome components (rounded borders, footer, mission
 * card, quick commands) the shell renders so the bounded output fits
 * within `capabilities.rows` lines.
 *
 * - `full`       ≥ 22 rows, ≥ 60 cols — full chrome including mission card
 * - `standard`   ≥ 20 rows             — full chrome without footer
 * - `compact`    ≥ 18 rows             — flat mission card, no quick-commands card
 * - `minimal`    <  18 rows or < 50 cols — flat prompt line, no card chrome
 */
export type CompactnessTier = "full" | "standard" | "compact" | "minimal";

export function compactnessTier(caps: TerminalCapabilities): CompactnessTier {
  if (caps.rows < 18 || caps.columns < 50) return "minimal";
  const wide = isWideTerminal(caps);
  // Stacked layouts (columns < 60) burn a lot more rows than wide layouts
  // because the sidebar stacks above the main content. Treat them as
  // `compact` so the row budget fits.
  if (!wide) return "compact";
  // The full chrome (mission card, quick commands panel, footer) needs a
  // comfortable row budget — at 80×24 we drop the footer and quick-commands
  // card chrome so the typed command and key hint stay visible.
  if (caps.rows < 26) return "standard";
  return "full";
}
export function availableTranscriptRows(caps: TerminalCapabilities): number {
  // Reserve rows for chrome (header, sidebar, mission card, quick commands
  // panel, footer, contextual action panel) plus the prompt line. Older
  // noncritical transcript lines are dropped first; the critical URI, code,
  // recommendation ID, action, and typed input strings survive because they
  // live in the most recently appended entries.
  const tier = compactnessTier(caps);
  const wide = isWideTerminal(caps);
  const chrome =
    2 + // header (status row + bottom border)
    (wide ? 1 : 5) + // sidebar (compact stacks above content)
    (tier === "full" ? 8 : tier === "standard" ? 6 : tier === "compact" ? 2 : 0) +
    (tier === "full" ? 2 : 0) + // footer
    2 + // context actions panel header + border
    1; // prompt line
  return Math.max(0, caps.rows - chrome);
}


const SECTION_ICONS: Readonly<Record<string, { readonly icon: string; readonly accent: Accent }>> = {
  home: { icon: "⌂", accent: "cyan" },
  find: { icon: "⌕", accent: "purple" },
  mission: { icon: "◆", accent: "yellow" },
  agent: { icon: "◇", accent: "purple" },
  verify: { icon: "✓", accent: "green" },
  progress: { icon: "▰", accent: "green" },
  journey: { icon: "↗", accent: "cyan" },
  auth: { icon: "◎", accent: "green" },
  preferences: { icon: "⚙", accent: "cyan" },
};

export type NavigationRowState = {
  readonly focused: boolean;
  readonly selected: boolean;
  readonly availability: "enabled" | "disabled";
};

export function navigationRowMarkers(state: NavigationRowState): string {
  const focus = state.focused ? ">" : " ";
  const selection = state.selected ? "*" : " ";
  const availability = state.availability === "enabled" ? "-" : "x";
  return `${focus}${selection}${availability}`;
}

export const HEADER_LABEL = "KESTREL";
export const HEADER_SUBTITLE = "LOCAL WORKSPACE";

export interface NavItemProps {
  readonly icon: string;
  readonly label: string;
  readonly focused?: boolean;
  readonly selected?: boolean;
  readonly availability?: "enabled" | "disabled";
  readonly accent?: Accent;
  readonly colorize?: boolean;
}

export function NavItem({
  icon,
  label,
  focused = false,
  selected = false,
  availability = "enabled",
  accent = "cyan",
  colorize = true,
}: NavItemProps) {
  const markers = navigationRowMarkers({ focused, selected, availability });
  const markerColor =
    availability === "disabled"
      ? COLORS.red
      : focused
        ? COLORS.text
        : selected
          ? COLORS.green
          : COLORS.muted;
  const labelColor =
    availability === "disabled"
      ? COLORS.muted
      : focused || selected
        ? COLORS.text
        : COLORS.muted;
  return (
    <Box>
      <Text color={colorize ? markerColor : undefined}>{markers}</Text>
      <Text color={colorize ? COLORS[accent] : undefined}>{icon}</Text>
      <Text>{"  "}</Text>
      <Text color={colorize ? labelColor : undefined} bold={focused}>
        {label}
      </Text>
    </Box>
  );
}

export function SectionLabel({ label }: { readonly label: string }) {
  return (
    <Text color={COLORS.muted} dimColor>
      {label.toUpperCase()}
    </Text>
  );
}

export interface CommandRowProps {
  readonly command: string;
  readonly description: string;
  readonly accent?: Accent;
}

export function CommandRow({ command, description, accent = "cyan" }: CommandRowProps) {
  return (
    <Box>
      <Box width={22}>
        <Text color={COLORS[accent]}>{command}</Text>
      </Box>
      <Text color={COLORS.muted}>{description}</Text>
    </Box>
  );
}

export interface ContextActionsProps {
  readonly actions: readonly SessionAction[];
  readonly selectedIndex?: number;
  readonly focused?: boolean;
  readonly colorize?: boolean;
  readonly compact?: boolean;
}

export function ContextActions({
  actions,
  selectedIndex = -1,
  focused = false,
  colorize = true,
  compact = false,
}: ContextActionsProps) {
  if (actions.length === 0) {
    return (
      <Box flexDirection="column" marginTop={compact ? 0 : 1}>
        <SectionLabel label="Actions" />
        <Text color={COLORS.muted}>No actions available.</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginTop={compact ? 0 : 1}>
      <SectionLabel label="Actions" />
      <Box
        borderStyle={compact ? undefined : "round"}
        borderColor={COLORS.borderSoft}
        flexDirection="column"
        paddingX={1}
        paddingY={0}
        marginTop={compact ? 0 : 1}
      >
        {actions.map((action, index) => {
          const row: NavigationRowState = {
            focused: focused && selectedIndex === index,
            selected: selectedIndex === index,
            availability:
              action.availability.status === "enabled" ? "enabled" : "disabled",
          };
          const markers = navigationRowMarkers(row);
          const isDisabled = action.availability.status === "disabled";
          const commandColor = isDisabled ? COLORS.muted : COLORS.cyan;
          return (
            <Box key={action.id} flexDirection="column">
              <Box>
                <Text color={colorize ? (isDisabled ? COLORS.red : COLORS.text) : undefined}>
                  {markers}
                </Text>
                <Text>{" "}</Text>
                <Text color={colorize ? COLORS.muted : undefined} bold={row.focused}>
                  {action.label}
                </Text>
              </Box>
              <Box marginLeft={4}>
                <Text color={colorize ? commandColor : undefined}>{action.command}</Text>
              </Box>
              {isDisabled ? (
                <Box marginLeft={4}>
                  <Text color={colorize ? COLORS.muted : undefined}>
                    {action.availability.reason}
                    {action.availability.recoveryCommand !== undefined
                        ? ` · ${action.availability.recoveryCommand}`
                        : ""}
                  </Text>
                </Box>
              ) : null}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

export interface SmallStatProps {
  readonly title: string;
  readonly value: string;
  readonly detail: string;
  readonly icon: string;
  readonly accent: Accent;
}

export function SmallStat({ title, value, detail, icon, accent }: SmallStatProps) {
  return (
    <Box
      borderStyle="round"
      borderColor={COLORS.borderSoft}
      flexDirection="column"
      paddingX={1}
      paddingY={0}
      flexGrow={1}
    >
      <Box justifyContent="space-between">
        <SectionLabel label={title} />
        <Text color={COLORS[accent]}>{icon}</Text>
      </Box>

      <Box marginTop={1}>
        <Text color={COLORS.text} bold>
          {value}
        </Text>
      </Box>

      <Text color={COLORS.muted}>{detail}</Text>
    </Box>
  );
}

export interface SidebarProps {
  readonly selectedIndex?: number;
  readonly focusedIndex?: number;
  readonly capabilities: TerminalCapabilities;
  readonly availability?: ReadonlyArray<"enabled" | "disabled">;
  readonly compact?: boolean;
}

export function Sidebar({
  selectedIndex = 0,
  focusedIndex = -1,
  capabilities,
  availability,
  compact = false,
}: SidebarProps) {
  const wide = isWideTerminal(capabilities);
  const items = NAVIGATION_SECTIONS.map((section, index) => {
    const meta = SECTION_ICONS[section.id] ?? { icon: "·", accent: "cyan" as Accent };
    const state: NavigationRowState = {
      focused: focusedIndex === index,
      selected: selectedIndex === index,
      availability: availability?.[index] ?? "enabled",
    };
    return { section, meta, state };
  });
  if (compact) {
    // Compact tier: a single horizontal row of marker+icon indicators so
    // the user can still scan the active category without losing a column.
    return (
      <Box
        width="100%"
        flexShrink={0}
        borderStyle="single"
        borderTop={false}
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
        borderColor={COLORS.borderSoft}
        flexDirection="row"
        flexWrap="wrap"
        gap={1}
        paddingX={1}
        paddingTop={0}
      >
        {items.map(({ section, meta, state }) => (
          <Box key={section.id}>
            <Text color={capabilities.color ? COLORS[meta.accent] : undefined}>{meta.icon}</Text>
            <Text color={capabilities.color ? (state.selected ? COLORS.green : COLORS.muted) : undefined}>
              {state.selected ? "●" : "○"}
            </Text>
          </Box>
        ))}
      </Box>
    );
  }
  return (
    <Box
      width={wide ? 24 : "100%"}
      flexShrink={0}
      borderStyle="single"
      borderTop={false}
      borderBottom={false}
      borderLeft={false}
      borderRight={wide}
      borderColor={COLORS.borderSoft}
      flexDirection="column"
      paddingX={1}
    >
      <SectionLabel label="Navigate" />

      <Box flexDirection="column" marginTop={1}>
        {items.map(({ section, meta, state }) => (
          <NavItem
            key={section.id}
            icon={meta.icon}
            label={section.label}
            focused={state.focused}
            selected={state.selected}
            availability={state.availability}
            accent={meta.accent}
            colorize={capabilities.color}
          />
        ))}
      </Box>

      <Box flexDirection="column">
        <Text color={COLORS.muted}>
          <Text color={COLORS.text}>↑↓</Text> move
        </Text>
        <Text color={COLORS.muted}>
          <Text color={COLORS.text}>enter</Text> select
        </Text>
      </Box>
    </Box>
  );
}

export interface HeaderProps {
  readonly status: string;
  readonly statusAccent?: Accent;
  readonly compact?: boolean;
}

export function Header({ status, statusAccent = "green", compact = false }: HeaderProps) {
  // The `compact` flag hides only the `session` label next to the status
  // indicator; the KESTREL / LOCAL WORKSPACE title is retained at every
  // tier because the original session's calm status bar always surfaced it.
  return (
    <Box
      borderStyle="single"
      borderTop={false}
      borderLeft={false}
      borderRight={false}
      borderColor={COLORS.border}
      paddingX={1}
      justifyContent="space-between"
    >
      <Box>
        <Text color={COLORS.text} bold>
          {HEADER_LABEL}
        </Text>
        <Text color={COLORS.muted}> / {HEADER_SUBTITLE}</Text>
      </Box>

      <Box>
        {!compact ? <Text color={COLORS.muted}>session </Text> : null}
        <Text color={COLORS[statusAccent]}>● {status}</Text>
      </Box>
    </Box>
  );
}
export interface MissionCardProps {
  readonly title: string;
  readonly description: string;
  readonly suggestions: readonly { readonly command: string; readonly accent: Accent }[];
  readonly compact?: boolean;
}

export function MissionCard({ title, description, suggestions, compact = false }: MissionCardProps) {
  return (
    <Box
      borderStyle={compact ? "single" : "round"}
      borderColor={compact ? COLORS.borderSoft : COLORS.border}
      flexDirection="column"
      paddingX={1}
      paddingY={0}
    >
      <Box justifyContent="space-between">
        <Box flexDirection="column">
          <SectionLabel label="Current mission" />
          <Text color={COLORS.text} bold>
            {title}
          </Text>
        </Box>

        {!compact ? <Text color={COLORS.yellow}>◆</Text> : null}
      </Box>

      {compact ? null : (
        <Box marginTop={1}>
          <Text color={COLORS.muted}>{description}</Text>
        </Box>
      )}

      {suggestions.length > 0 && !compact ? (
        <Box marginTop={1} gap={2}>
          {suggestions.map((suggestion) => (
            <Text key={suggestion.command} color={COLORS[suggestion.accent]}>
              {suggestion.command}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

export interface QuickCommandsProps {
  readonly commands: readonly CommandRowProps[];
  readonly compact?: boolean;
}

export function QuickCommands({ commands, compact = false }: QuickCommandsProps) {
  if (compact) {
    // Compact tier omits the Quick Commands panel chrome entirely; the active
    // section's contextual actions already give the user the commands they
    // can run. Keeping this in the public API lets the dashboard decide when
    // to drop it without changing prop contracts.
    return null;
  }
  return (
    <Box flexDirection="column">
      <SectionLabel label="Quick commands" />

      <Box
        borderStyle="round"
        borderColor={COLORS.borderSoft}
        flexDirection="column"
        paddingX={1}
        paddingY={0}
        marginTop={1}
      >
        {commands.map((command) => (
          <CommandRow
            key={command.command}
            command={command.command}
            description={command.description}
            accent={command.accent ?? "cyan"}
          />
        ))}
      </Box>
    </Box>
  );
}

export interface DashboardStat {
  readonly title: string;
  readonly value: string;
  readonly detail: string;
  readonly icon: string;
  readonly accent: Accent;
}

export interface DashboardProps {
  readonly title: string;
  readonly subtitle: string;
  readonly sessionStatus: string;
  readonly mission: MissionCardProps;
  readonly stats: readonly DashboardStat[];
  readonly quickCommands: readonly CommandRowProps[];
  readonly compact?: boolean;
}

export function Dashboard({
  title,
  subtitle,
  sessionStatus,
  mission,
  stats,
  quickCommands,
  compact = false,
}: DashboardProps) {
  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {compact ? null : (
        <Box justifyContent="space-between">
          <Box flexDirection="column">
            <Text color={COLORS.muted}>{subtitle}</Text>
            <Text color={COLORS.text} bold>
              {title}
            </Text>
          </Box>

          <Box alignItems="flex-end">
            <Text color={COLORS.muted}>
              session <Text color={COLORS.green}>{sessionStatus}</Text>
            </Text>
          </Box>
        </Box>
      )}

      <Box marginTop={compact ? 0 : 1}>
        <MissionCard
          title={mission.title}
          description={mission.description}
          suggestions={mission.suggestions}
          compact={compact}
        />
      </Box>

      {stats.length > 0 && !compact ? (
        <Box marginTop={1} gap={1}>
          {stats.map((stat) => (
            <SmallStat
              key={stat.title}
              title={stat.title}
              value={stat.value}
              detail={stat.detail}
              icon={stat.icon}
              accent={stat.accent}
            />
          ))}
        </Box>
      ) : null}

      <Box marginTop={compact ? 0 : 1}>
        <QuickCommands commands={quickCommands} compact={compact} />
      </Box>
    </Box>
  );
}

export interface PromptLineProps {
  readonly input: string;
  readonly busy: boolean;
  readonly placeholder: string;
}

export function PromptLine({ input, busy, placeholder }: PromptLineProps) {
  return (
    <Box
      borderStyle="single"
      borderLeft={false}
      borderRight={false}
      borderBottom={false}
      borderColor={COLORS.border}
      paddingX={1}
      paddingTop={0}
    >
      <Text color={COLORS.green} bold>
        ›{" "}
      </Text>
      {input.length > 0 ? (
        <Text color={COLORS.text}>{input}</Text>
      ) : (
        <Text color={COLORS.muted}>{placeholder}</Text>
      )}
      {busy ? <Text color={COLORS.yellow}> Working… (Ctrl+C to cancel)</Text> : null}
    </Box>
  );
}

export function Footer() {
  return (
    <Box
      borderStyle="single"
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      borderColor={COLORS.border}
      paddingX={1}
      justifyContent="space-between"
    >
      <Text color={COLORS.muted}>
        <Text color={COLORS.green}>●</Text> KESTREL local
      </Text>

      <Text color={COLORS.muted}>/help · /clear · /exit</Text>
    </Box>
  );
}

export interface DashboardShellProps {
  readonly status: string;
  readonly statusAccent?: Accent;
  readonly title: string;
  readonly subtitle: string;
  readonly sessionStatus: string;
  readonly mission: MissionCardProps;
  readonly stats: readonly DashboardStat[];
  readonly quickCommands: readonly CommandRowProps[];
  readonly selectedNavigationIndex?: number;
  readonly focusedNavigationIndex?: number;
  readonly input: string;
  readonly busy: boolean;
  readonly placeholder: string;
  readonly capabilities: TerminalCapabilities;
  readonly contextActions?: readonly SessionAction[];
  readonly selectedActionIndex?: number;
  readonly actionFocused?: boolean;
  readonly children?: ReactNode;
}

export function DashboardShell({
  status,
  statusAccent = "green",
  title,
  subtitle,
  sessionStatus,
  mission,
  stats,
  quickCommands,
  selectedNavigationIndex = 0,
  focusedNavigationIndex = -1,
  input,
  busy,
  placeholder,
  capabilities,
  contextActions,
  selectedActionIndex = 0,
  actionFocused = false,
  children,
}: DashboardShellProps) {
  const wide = isWideTerminal(capabilities);
  const tier = compactnessTier(capabilities);
  const compact = tier !== "full";
  const omitDashboardChrome = tier === "minimal";
  const showFooter = tier === "full";
  const showQuickCommands = tier === "full" || tier === "standard";
  const sidebarCompact = tier === "compact" || tier === "minimal";
  // Window the children (transcript / output entries) to honour the actual
  // terminal row budget. Older noncritical lines are dropped first; the most
  // recent entries (which include the critical URI, code, recommendation ID,
  // action, and typed input strings) survive.
  const transcriptBudget = availableTranscriptRows(capabilities);
  const allChildren = Children.toArray(children);
  const visibleChildren =
    transcriptBudget <= 0
      ? []
      : allChildren.length > transcriptBudget
        ? allChildren.slice(-transcriptBudget)
        : allChildren;

  return (
    <Box flexDirection="column" width="100%">
      <Header status={status} statusAccent={statusAccent} compact={compact} />

      <Box flexDirection={wide ? "row" : "column"}>
        <Sidebar
          selectedIndex={selectedNavigationIndex}
          focusedIndex={focusedNavigationIndex}
          capabilities={capabilities}
          compact={sidebarCompact}
        />
        <Box flexDirection="column" flexGrow={1}>
          {omitDashboardChrome ? null : (
            <Dashboard
              title={title}
              subtitle={subtitle}
              sessionStatus={sessionStatus}
              mission={mission}
              stats={stats}
              quickCommands={showQuickCommands ? quickCommands : []}
              compact={compact}
            />
          )}
          {contextActions !== undefined ? (
            <Box marginTop={compact ? 0 : 1} paddingX={1}>
              <ContextActions
                actions={contextActions}
                selectedIndex={selectedActionIndex}
                focused={actionFocused}
                colorize={capabilities.color}
                compact={compact}
              />
            </Box>
          ) : null}
          {visibleChildren}
          <PromptLine input={input} busy={busy} placeholder={placeholder} />
        </Box>
      </Box>

      {showFooter ? <Footer /> : null}
    </Box>
  );
}

export const DEFAULT_QUICK_COMMANDS: readonly CommandRowProps[] = [
  { command: "/find", description: "Discover a recommended challenge", accent: "purple" },
  { command: "/mission current", description: "Inspect the active mission", accent: "yellow" },
  { command: "/agent brief", description: "Create an agent handoff", accent: "purple" },
  { command: "/progress", description: "Review journey progress", accent: "green" },
];

export const DEFAULT_MISSION_SUGGESTIONS: readonly {
  readonly command: string;
  readonly accent: Accent;
}[] = [
  { command: "/find", accent: "purple" },
  { command: "/mission current", accent: "yellow" },
  { command: "/agent brief", accent: "purple" },
];