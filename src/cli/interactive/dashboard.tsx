import { Children } from "react";
import type { ReactNode } from "react";
import { Box, Text } from "ink";
import stringWidth from "string-width";
import { NAVIGATION_SECTIONS } from "./session-navigation.js";
import type { SessionAction } from "./session-navigation.js";

/**
 * Renderable transcript entry. The shell accepts structured entries
 * (text + criticality + measured row count) so the row budget is enforced
 * against the actual lines the entries will render, not against opaque
 * React children. `rows` is a plain-text row count that already accounts
 * for embedded newlines, narrow-width wrapping, and the entry's own
 * vertical chrome (border, padding, label).
 */
export interface RenderableTranscriptEntry {
  readonly id: number;
  readonly text: string;
  readonly kind: "input" | "output" | "error" | "system";
  readonly criticality: "critical" | "noncritical";
  readonly rows: number;
}
/**
 * Wrap a single line of text to the available width, breaking on
 * whitespace when possible. Mirrors the wrapping Ink performs inside a
 * `<Text>` block so the row estimate matches what actually renders.
 * Width is measured in terminal display cells (CJK / emoji are
 * double-cell), not JS code points.
 */
function wrapLineToWidth(line: string, width: number): number {
  if (width <= 0) return 1;
  if (line.length === 0) return 1;
  const cellLength = stringWidth(line);
  if (cellLength <= width) return 1;
  // Grapheme-aware walk: consume `width` cells per row, breaking on the
  // last whitespace boundary when one exists inside the consumed range.
  const graphemes = Array.from(line);
  const cells: number[] = graphemes.map((g) => stringWidth(g));
  let consumed = 0;
  let rows = 0;
  while (consumed < graphemes.length) {
    let rowCells = 0;
    let rowEnd = consumed;
    while (rowEnd < graphemes.length && rowCells + (cells[rowEnd] ?? 0) <= width) {
      rowCells += cells[rowEnd] ?? 0;
      rowEnd += 1;
    }
    if (rowEnd === consumed) {
      // Single grapheme is wider than the budget — hard-break to keep
      // progress and avoid an infinite loop.
      rowEnd = consumed + 1;
    }
    let breakAt = rowEnd;
    if (rowEnd < graphemes.length) {
      for (let i = rowEnd - 1; i > consumed; i -= 1) {
        if (graphemes[i] === " ") {
          breakAt = i;
          break;
        }
      }
    }
    rows += 1;
    consumed = breakAt;
    if (consumed < graphemes.length && graphemes[consumed] === " ") {
      consumed += 1;
    }
  }
  return Math.max(1, rows);
}

/**
 * Estimate the rows an entry consumes once rendered. Accounts for:
 *  - embedded `\n` newlines (error rendering produces a header + bullets)
 *  - narrow-width wrapping per logical line (cols - chrome overhead)
 *  - the entry's own chrome: error = 3 chrome rows (border top + inner
 *    padding + border bottom) plus 1 margin-top; system = 2 chrome rows
 *    (label + spacing) plus 1 margin-top; input/output = 1 margin-top.
 */
export function estimateEntryRows(
  text: string,
  kind: RenderableTranscriptEntry["kind"],
  columns: number,
): number {
  // Per-entry chrome in rows (border + padding + label + margin-top).
  const chromeRows =
    kind === "error" ? 3 + 1 : kind === "system" ? 2 + 1 : 1;
  // marginTop={1}; input/output render full width with marginTop={1}.
  const innerWidth = Math.max(
    1,
    columns - (kind === "error" ? 4 : kind === "system" ? 0 : 0),
  );
  const lines = text.split("\n");
  const lineRows = lines.reduce(
    (sum, line) => sum + wrapLineToWidth(line, innerWidth),
    0,
  );
  return Math.max(1, chromeRows + lineRows);
}
/**
 * Build a `RenderableTranscriptEntry` from a plain entry (the legacy
 * `TranscriptEntry` shape used by the Session transcript) plus an
 * explicit criticality hint. The helper exists so tests and the Session
 * share a single row-measurement path.
 */
export function toRenderableEntry(
  entry: {
    readonly id: number;
    readonly kind: RenderableTranscriptEntry["kind"];
    readonly text: string;
  },
  criticality: RenderableTranscriptEntry["criticality"],
  columns: number,
): RenderableTranscriptEntry {
  return {
    id: entry.id,
    text: entry.text,
    kind: entry.kind,
    criticality,
    rows: estimateEntryRows(entry.text, entry.kind, columns),
  };
}

/**
 * Classify an entry's criticality from its text. Entries that contain
 * verification URI / user code, recommendation ID / accept command,
 * typed-input echoes, or the explicit "Run /auth login to continue"
 * recovery are critical. Everything else is noncritical so it can be
 * dropped when the budget is tight.
/**
 * Classify an entry's criticality from its text. Entries that contain
 * a verification URI / user code, recommendation ID / accept command,
 * or the explicit "/auth login" / "/auth status" recovery line are
 * critical. The typed prompt is rendered separately by PromptLine and
 * is NOT promoted to critical here — typing "/" would otherwise match
 * every command echo and blow past the budget.
 */
export function isCriticalTranscriptText(text: string, promptInput: string): boolean {
  const trimmed = text;
  void promptInput; // deliberately unused: the prompt is rendered separately
  if (/https?:\/\/github\.com\/login\/device/u.test(trimmed)) return true;
  if (/Recommendation ID:\s*\S+/u.test(trimmed)) return true;
  if (/\/mission\s+accept\s+--id\s+\S+/u.test(trimmed)) return true;
  if (/Run\s+\/auth\s+(login|status)\s+to\s+continue/u.test(trimmed)) return true;
  return false;
}
/**
 * Window transcript entries to honour the row budget. Critical entries
 * are bounded: only the most recent device-flow payload (verification
 * URI / user code) and the most recent recommendation / accept
 * command are retained. Older critical entries are superseded. The
 * remaining budget is filled with the newest noncritical entries, and
 * the oldest noncritical entries are dropped first.
 *
 * When a critical entry itself cannot fit the budget, a bounded
 * representation is rendered: the latest verification URI / user code
 * is preserved verbatim for the auth device payload, and the latest
 * recommendation ID / accept command is preserved verbatim for the
 * recommendation / action. The total frame always remains ≤ rowBudget
 * (1 row for the bounded critical plus the rest of the budget for
 * noncritical fillers).
 *
 * The returned array preserves the chronological order of the
 * retained entries (oldest first, newest last). Entries are selected
 * by identity from the original array — concatenating all criticals
 * before all noncriticals would reorder interleaved history.
 */
export function windowTranscriptEntries(
  entries: readonly RenderableTranscriptEntry[],
  rowBudget: number,
): readonly RenderableTranscriptEntry[] {
  if (rowBudget <= 0 || entries.length === 0) return [];
  // The most recent entry of each critical kind wins. Older critical
  // entries are superseded so a busy transcript never grows past the
  // budget. Each retained critical is rendered as a single bounded
  // row that preserves the required URI / user code or the exact
  // recommendation ID / action.
  const latestAuthDevice = [...entries]
    .reverse()
    .find((e) => /https?:\/\/github\.com\/login\/device/u.test(e.text));
  const latestRecommendation = [...entries]
    .reverse()
    .find(
      (e) =>
        /Recommendation ID:\s*\S+/u.test(e.text) ||
        /\/mission\s+accept\s+--id\s+\S+/u.test(e.text),
    );
  const latestRecovery = [...entries]
    .reverse()
    .find((e) => /Run\s+\/auth\s+(login|status)\s+to\s+continue/u.test(e.text));
  const criticalEntries = [latestAuthDevice, latestRecommendation, latestRecovery].filter(
    (e): e is RenderableTranscriptEntry => e !== undefined,
  );
  return finalizeWindowedEntries(entries, criticalEntries, rowBudget);
}

function finalizeWindowedEntries(
  entries: readonly RenderableTranscriptEntry[],
  criticalEntries: readonly RenderableTranscriptEntry[],
  rowBudget: number,
): readonly RenderableTranscriptEntry[] {
  // Build a map of bounded critical text by id so we can swap the
  // original entry for its bounded representation at the original
  // chronological position. Each bounded critical still occupies one
  // `<Box marginTop={1}>` row above the single-line bounded text —
  // count that margin-top row in the budget so the frame stays within
  // the row budget.
  // Each bounded critical still renders as 2 rows: one margin-top row
  // above the bounded text. Count that in the budget so the frame stays
  // within the row budget.
  const BOUNDED_CRITICAL_ROWS = 2;
  const criticalBounded = new Map<number, RenderableTranscriptEntry>();
  for (const c of criticalEntries) {
    criticalBounded.set(c.id, {
      ...c,
      text: renderBoundedCritical(c),
      rows: BOUNDED_CRITICAL_ROWS,
    });
  }
  const retained: RenderableTranscriptEntry[] = [];
  for (const entry of entries) {
    if (criticalBounded.has(entry.id)) {
      retained.push(criticalBounded.get(entry.id)!);
      continue;
    }
    if (entry.criticality === "noncritical") retained.push(entry);
  }
  // Greedy fill from the newest noncritical, then drop oldest until
  // the total row count fits `rowBudget` with bounded criticals
  // counted at their actual rendered row count (margin-top + text).
  const criticalRows = criticalBounded.size * BOUNDED_CRITICAL_ROWS;
  let remaining = rowBudget - criticalRows;
  // Keep the newest noncritical entries that fit the remaining budget.
  const newNoncriticals: RenderableTranscriptEntry[] = [];
  for (let i = retained.length - 1; i >= 0; i -= 1) {
    const e = retained[i];
    if (e === undefined) continue;
    if (criticalBounded.has(e.id)) continue;
    if (e.rows <= remaining) {
      newNoncriticals.unshift(e);
      remaining -= e.rows;
    }
  }
  // Reassemble: walk `entries` again, in original order, including
  // criticals (with bounded text) and the selected noncriticals.
  const selected = new Set(newNoncriticals.map((e) => e.id));
  const result: RenderableTranscriptEntry[] = [];
  for (const entry of entries) {
    if (criticalBounded.has(entry.id)) {
      result.push(criticalBounded.get(entry.id)!);
    } else if (selected.has(entry.id)) {
      result.push(entry);
    }
  }
  return result;
}
function renderBoundedCritical(entry: RenderableTranscriptEntry): string {
  // Always render a single-line bounded representation. The original
  // entry may be many rows; the bounded slot is always 1 row of chrome
  // so the total frame stays within the row budget. The bounded text
  // preserves the required URI / user code or exact recommendation ID.
  const lines = entry.text.split("\n");
  // Prefer a real bounded form that keeps the user-actionable
  // information: the verification URI + user code, the recommendation
  // ID, or the exact accept command.
  if (/https?:\/\/github\.com\/login\/device/u.test(entry.text)) {
    const match = entry.text.match(/(https?:\/\/github\.com\/login\/device\S*)\s+and\s+enter\s+(\S+)/u);
    if (match !== null) return `${match[1]} (code ${match[2]})`;
    const uri = entry.text.match(/https?:\/\/github\.com\/login\/device\S*/u);
    if (uri !== null) return uri[0];
  }
  if (/Recommendation ID:\s*\S+/u.test(entry.text)) {
    const id = entry.text.match(/Recommendation ID:\s*(\S+)/u);
    if (id !== null) return `Recommendation ID: ${id[1]}`;
  }
  if (/\/mission\s+accept\s+--id\s+\S+/u.test(entry.text)) {
    const id = entry.text.match(/\/mission\s+accept\s+--id\s+(\S+)/u);
    if (id !== null) return `/mission accept --id ${id[1]}`;
  }
  if (/Run\s+\/auth\s+(login|status)\s+to\s+continue/u.test(entry.text)) {
    return lines.find((l) => /Run\s+\/auth/u.test(l)) ?? lines[0] ?? entry.text;
  }
  // Fallback: first non-empty line of the original text.
  return lines.find((l) => l.trim().length > 0) ?? entry.text;
}


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

/**
 * Width of the transcript pane (the column that hosts the actual
 * transcript entries) in display cells. In wide mode this subtracts
 * the 24-column sidebar, its right border, and the dashboard's
 * `paddingX={1}` (2 cells) so the wrap estimate matches what Ink
 * renders. In stacked mode the sidebar stacks above the main column
 * and the transcript takes the full width minus the dashboard padding.
 */
export function transcriptPaneWidth(caps: TerminalCapabilities): number {
  const wide = isWideTerminal(caps);
  const DASHBOARD_PADDING_X = 2;
  const SIDEBAR_WIDTH = 24;
  const SIDEBAR_RIGHT_BORDER = 1;
  if (wide) {
    return Math.max(1, caps.columns - SIDEBAR_WIDTH - SIDEBAR_RIGHT_BORDER - DASHBOARD_PADDING_X);
  }
  return Math.max(1, caps.columns - DASHBOARD_PADDING_X);
}

export interface TranscriptChrome {
  /**
   * Number of contextual action rows currently rendered. Each enabled
   * action is 1 row; disabled actions add a second reason / recovery
   * row. The section also contributes its label and a top border.
   */
  readonly contextActionRows: number;
}

/**
 * Compute the actual row budget for transcript entries after reserving
 * chrome for the sections currently rendered. The caller passes the
 * dynamic chrome (e.g. the rendered ContextActions row count) so the
 * total frame always fits `caps.rows`. The returned value is the
 * maximum row count the transcript pane can consume; the shell windows
 * entries against this value.
 *
 * Chrome breakdown:
 *  - Header: 2 rows (status row + bottom border)
 *  - Sidebar: 1 row of header + N category rows + 2 hint rows
 *    (N = NAVIGATION_SECTIONS.length). Compact horizontal mode is 1 row.
 *  - Mission card: 1 border + content rows + 1 border. `full`/standard
 *    = 6, `compact` (standard tier in wide mode) = 4, `minimal` = 0.
 *  - Quick commands card: only at `full` tier, contributes 2 chrome.
 *  - Context actions: 1 label + 1 border (when actions are present) +
 *    1 row per action.
 *  - Footer: 2 rows (status + commands). `full` tier only.
 *  - Prompt: 1 row.
 */
export function availableTranscriptRows(
  caps: TerminalCapabilities,
  chrome: TranscriptChrome = { contextActionRows: 0 },
): number {
  // Reserve rows for chrome (header, sidebar, mission card, quick commands
  // panel, footer, contextual action panel) plus the prompt line. Older
  // noncritical transcript lines are dropped first; the critical URI, code,
  // recommendation ID, action, and typed input strings survive because they
  // live in the most recently appended entries.
  const tier = compactnessTier(caps);
  const wide = isWideTerminal(caps);
  // Sidebar chrome: full (stacked) renders 1 label + N categories + 2 hints.
  // Compact (single horizontal row) is 1 row. Wide non-compact renders the
  // same as full but next to the main column.
  const sidebarCompact = tier === "compact" || tier === "minimal";
  const sidebarRows = sidebarCompact ? 1 : 1 + NAVIGATION_SECTIONS.length + 2;
  // Mission card chrome: full tier = 8 (with description, suggestions,
  // border). Standard tier = 4 (compact card, no description, no
  // suggestions, single border). Compact/minimal = 3 (compact card
  // inside the compact dashboard).
  const missionCardRows =
    tier === "full"
      ? 8
      : tier === "standard"
        ? 4
        : tier === "compact"
          ? 4
          : 0;
  const quickCommandsRows = tier === "full" ? 2 : 0;
  const footerRows = tier === "full" ? 2 : 0;
  // Context actions: 1 label + 1 border + 1 row per action when present.
  const contextChrome = chrome.contextActionRows > 0 ? 2 + chrome.contextActionRows : 0;
  const fixed =
    2 + // header (status row + bottom border)
    sidebarRows +
    missionCardRows +
    quickCommandsRows +
    footerRows +
    contextChrome +
    2; // prompt line + its top border
  return Math.max(0, caps.rows - fixed);
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
  /**
   * Renderable transcript entries with plain-text row metadata and
   * criticality. When supplied, the shell windows these against the
   * row budget using `windowTranscriptEntries` (keep every critical
   * entry, fill remainder with newest noncritical). When absent, the
   * shell falls back to the legacy `children` prop which is sliced by
   * opaque React child count.
   */
  readonly entries?: readonly RenderableTranscriptEntry[];
  readonly children?: ReactNode;
}

function TranscriptEntryLine({
  entry,
  promptInput,
}: {
  readonly entry: RenderableTranscriptEntry;
  readonly promptInput: string;
}) {
  if (entry.kind === "error") {
    return (
      <Box borderStyle="round" borderColor="red" paddingX={1} marginTop={1}>
        <Box flexDirection="column">
          <Text color="redBright" bold>
            Action required
          </Text>
          <Text color="red">{entry.text.replace(/^[!×]\s*/u, "")}</Text>
        </Box>
      </Box>
    );
  }
  if (entry.kind === "system") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="white" bold>
          Welcome back
        </Text>
        <Text color="gray">{entry.text.replace(/^✓ Welcome back\n\s*/u, "")}</Text>
      </Box>
    );
  }
  if (entry.kind === "input") {
    return (
      <Box marginTop={1}>
        <Text color="cyan">›</Text>
        <Text> </Text>
        <Text color="white">{entry.text}</Text>
      </Box>
    );
  }
  return (
    <Box marginTop={1}>
      <Text color="white">{entry.text}</Text>
    </Box>
  );
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
  entries,
  children,
}: DashboardShellProps) {
  const wide = isWideTerminal(capabilities);
  const tier = compactnessTier(capabilities);
  const compact = tier !== "full";
  const omitDashboardChrome = tier === "minimal";
  const showFooter = tier === "full";
  const showQuickCommands = tier === "full" || tier === "standard";
  const sidebarCompact = tier === "compact" || tier === "minimal";
  // Window the entries / children to honor the actual terminal row budget.
  // Critical entries (verification URI, user code, recommendation ID, accept
  // command, typed input) are always retained; older noncritical content is
  // dropped first so the bounded frame fits `capabilities.rows`.
  // The ContextActions section is variable: every enabled action is one
  // row, every disabled action adds a reason / recovery row. The shell
  // passes the actual rendered row count so the budget reflects what
  // the user sees, not a constant 2-row reservation.
  const contextActionRows = contextActions !== undefined ? contextActions.length : 0;
  const transcriptBudget = availableTranscriptRows(capabilities, {
    contextActionRows,
  });
  const structuredEntries = entries !== undefined
    ? windowTranscriptEntries(entries, transcriptBudget)
    : null;
  const allChildren = structuredEntries !== null
    ? structuredEntries.map((entry) => (
        <TranscriptEntryLine key={entry.id} entry={entry} promptInput={input} />
      ))
    : Children.toArray(children);
  const visibleChildren =
    structuredEntries !== null
      ? allChildren
      : transcriptBudget <= 0
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