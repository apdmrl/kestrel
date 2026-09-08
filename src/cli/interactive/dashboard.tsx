import { Children } from "react";
import type { ReactNode } from "react";
import { Box, Text } from "ink";
import stringWidth from "string-width";
import { NAVIGATION_SECTIONS } from "./session-navigation.js";
import type { SessionAction } from "./session-navigation.js";

/**
 * One transcript entry with its measured terminal row count. The session
 * retains bounded in-memory history; the dashboard selects one contiguous
 * page without reordering entries.
 */
export interface RenderableTranscriptEntry {
  readonly id: number;
  readonly text: string;
  readonly kind: "input" | "output" | "error" | "system";
  readonly rows: number;
}
/**
 * Wrap a single line of text to the available width, breaking on
 * Wrap a single line of text to the available width, breaking on
 * whitespace when possible. Mirrors the wrapping Ink performs inside a
 * `<Text>` block so the row estimate matches what actually renders.
 * Width is measured in terminal display cells (CJK / emoji are
 * double-cell), not JS code points.
 */
/**
 * Split a string into Unicode grapheme clusters using
 * `Intl.Segmenter({ granularity: "grapheme" })`. A keycap emoji
 * (`1️⃣` = `1` + VS16 + combining keycap) is one cluster with two
 * terminal cells; a ZWJ family (`👨‍👩‍👧‍👦`) is also one cluster. Code-point
 * splitting (`Array.from`) breaks both into multiple pieces whose cell
 * widths differ from the painted glyph and mis-counts when wrapping.
 */
export function segmentGraphemes(line: string): readonly string[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const out: string[] = [];
  for (const segment of segmenter.segment(line)) {
    out.push(segment.segment);
  }
  return out;
}

export function wrapLineToWidth(line: string, width: number): number {
  if (line.length === 0) return 1;
  // Pre-compute the cell width of every code point; for plain ASCII
  // the array length matches the cell count, but CJK / emoji are
  // double-cell. Per-grapheme cluster would be more correct (so a
  // multi-codepoint emoji like 🦄 is one cell) — string-width already
  // does that internally.
  const cellLength = stringWidth(line);
  if (cellLength <= width) return 1;
  let rows = 0;
  let cursor = 0;
  // Grapheme-aware walk: each iteration consumes `width` cells worth of
  // grapheme clusters. The cells-per-grapheme map is derived once per
  // line to avoid the quadratic cost on long inputs.
  const graphemes = segmentGraphemes(line);
  const cells: number[] = graphemes.map((g) => stringWidth(g));
  let consumed = 0;
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
    // Try a soft break on whitespace within the consumed range.
    let breakAt = rowEnd;
    if (rowEnd < graphemes.length) {
      for (let i = rowEnd - 1; i > consumed; i -= 1) {
        if (graphemes[i] === " ") {
          breakAt = i;
          break;
        }
      }
    }
    cursor = breakAt;
    rows += 1;
    consumed = cursor;
    // Skip the leading space on the next line if we broke on one.
    if (consumed < graphemes.length && graphemes[consumed] === " ") {
      consumed += 1;
    }
  }
  return Math.max(1, rows);
}

/**
 * Estimate the rows an entry consumes once rendered. Accounts for:
 *  - embedded `\n` newlines (error rendering produces a header + bullets)
 *  - narrow-width wrapping per logical line (cells - chrome overhead)
 *  - the entry's own chrome: error = 3 chrome rows (border top + inner
 *    padding + border bottom) plus 1 margin-top; system = 2 chrome rows
 *    (label + spacing) plus 1 margin-top; input/output = 1 margin-top.
 */
export function estimateEntryRows(
  text: string,
  kind: RenderableTranscriptEntry["kind"],
  columns: number,
): number {
  const chromeRows = kind === "error" ? 3 + 1 : kind === "system" ? 2 + 1 : 1;

  const innerWidth = Math.max(1, columns - (kind === "error" ? 4 : kind === "system" ? 0 : 0));
  const lines = text.split("\n");
  const lineRows = lines.reduce((sum, line) => sum + wrapLineToWidth(line, innerWidth), 0);
  return Math.max(1, chromeRows + lineRows);
}
/**
 * Compute the actual row count that the `ContextActions` panel will
 * render given the supplied action list. Mirrors the component's
 * chrome path exactly so the row budget reflects what Ink paints, not
 * a constant per-action reservation:
 *
 *   - Outer `<Box flexDirection="column" marginTop={1}>` (non-compact
 *     only) — one row.
 *   - `<SectionLabel label="Actions" />` — one row.
 *   - Inner `<Box marginTop={1}>` on the bordered container — one row.
 *   - Top + bottom border of the inner container — two rows.
 *   - Per-action body rows: enabled = 2 (label + command), disabled = 3
 *     (label + command + reason/recovery). The reason may wrap on
 *     narrow panes; the cell width is remeasured against `paneWidth`
 *     so long reasons never push the helper past the rendered output.
 *
 * `paneWidth` is the transcript pane width (see `transcriptPaneWidth`).
 * `compact` mirrors the production `compactnessTier` flag.
 */
function contextActionWidths(
  paneWidth: number,
  compact: boolean,
): { readonly content: number; readonly indented: number } {
  const content = Math.max(1, paneWidth - 4 - (compact ? 0 : 2));
  return { content, indented: Math.max(1, content - 4) };
}

function actionRowCount(action: SessionAction, paneWidth: number, compact: boolean): number {
  const widths = contextActionWidths(paneWidth, compact);
  const labelRows = wrapLineToWidth(`--- ${action.label}`, widths.content);
  const commandRows = wrapLineToWidth(action.command, widths.indented);
  if (action.availability.status === "disabled") {
    const reasonRows = wrapLineToWidth(action.availability.reason, widths.indented);
    const recoveryRows =
      action.availability.recoveryCommand === undefined
        ? 0
        : wrapLineToWidth(action.availability.recoveryCommand, widths.indented);
    return labelRows + commandRows + reasonRows + recoveryRows;
  }
  return labelRows + commandRows;
}

function actionWindow(
  actions: readonly SessionAction[],
  selectedIndex: number,
  paneWidth: number,
  compact: boolean,
  viewportRows: number | undefined,
): readonly SessionAction[] {
  if (viewportRows === undefined || actions.length === 0) return actions;
  const selected = Math.max(0, Math.min(selectedIndex, actions.length - 1));
  let start = selected;
  let end = selected;
  let rows = actionRowCount(actions[selected]!, paneWidth, compact);
  while (true) {
    const before = start > 0 ? actionRowCount(actions[start - 1]!, paneWidth, compact) : Infinity;
    const after =
      end < actions.length - 1 ? actionRowCount(actions[end + 1]!, paneWidth, compact) : Infinity;
    if (before === Infinity && after === Infinity) return actions.slice(start, end + 1);
    if (before <= after && rows + before <= viewportRows) {
      start -= 1;
      rows += before;
      continue;
    }
    if (rows + after <= viewportRows) {
      end += 1;
      rows += after;
      continue;
    }
    return actions.slice(start, end + 1);
  }
}

export function contextActionsRowCount(
  actions: readonly SessionAction[],
  paneWidth: number,
  compact: boolean,
  viewportRows?: number,
): number {
  const wrapperMargin = compact ? 0 : 1;
  const outerMargin = compact ? 0 : 1;
  const sectionLabel = 1;
  if (actions.length === 0 && viewportRows === undefined) {
    return wrapperMargin + outerMargin + sectionLabel + 1;
  }
  const innerMargin = compact ? 0 : 1;
  const borders = compact ? 0 : 2;
  const bodyRows =
    viewportRows ??
    actions.reduce((sum, action) => sum + actionRowCount(action, paneWidth, compact), 0);
  return wrapperMargin + outerMargin + sectionLabel + innerMargin + borders + bodyRows;
}

export interface TranscriptViewport {
  readonly paneWidth: number;
  readonly rowBudget: number;
}

export function transcriptViewport(
  caps: TerminalCapabilities,
  contextActions?: readonly SessionAction[],
): TranscriptViewport {
  const tier = compactnessTier(caps);
  const compact = tier !== "full";
  const paneWidth = transcriptPaneWidth(caps);
  const actionViewportRows = ACTION_VIEWPORT_ROWS[tier];
  const contextActionRows =
    contextActions === undefined
      ? 0
      : contextActionsRowCount(contextActions, paneWidth, compact, actionViewportRows);
  return {
    paneWidth,
    rowBudget: availableTranscriptRows(caps, { contextActionRows }),
  };
}

/**
 * Return one chronological transcript page. `offsetEntries` is the number of
 * newer entries hidden from the live tail. Paging moves only across complete
 * entries, so variable-height output remains reachable without overlap or
 * gaps.
 */
export function windowTranscriptPage(
  entries: readonly RenderableTranscriptEntry[],
  rowBudget: number,
  offsetEntries: number,
): readonly RenderableTranscriptEntry[] {
  if (rowBudget <= 0 || entries.length === 0) return [];
  const clampedOffset = Math.min(
    Math.max(0, Math.floor(offsetEntries)),
    entries.length - 1,
  );
  let cursor = entries.length - 1 - clampedOffset;
  const selected: RenderableTranscriptEntry[] = [];
  let selectedRows = 0;
  while (cursor >= 0) {
    const entry = entries[cursor];
    if (entry === undefined) break;
    const rows = Math.max(1, entry.rows);
    if (selected.length > 0 && selectedRows + rows > rowBudget) break;
    selected.push(entry);
    selectedRows += rows;
    cursor -= 1;
  }
  selected.reverse();
  return selected;
}

export function moveTranscriptPageOffset(
  entries: readonly RenderableTranscriptEntry[],
  rowBudget: number,
  offsetEntries: number,
  direction: "older" | "newer",
): number {
  if (rowBudget <= 0 || entries.length === 0) return 0;
  const currentOffset = Math.min(
    Math.max(0, Math.floor(offsetEntries)),
    entries.length - 1,
  );
  if (direction === "older") {
    const visibleCount = windowTranscriptPage(entries, rowBudget, currentOffset).length;
    return currentOffset + visibleCount < entries.length
      ? currentOffset + visibleCount
      : currentOffset;
  }
  if (currentOffset === 0) return 0;
  let previousOffset = 0;
  while (previousOffset < currentOffset) {
    const visibleCount = windowTranscriptPage(entries, rowBudget, previousOffset).length;
    const nextOffset = previousOffset + visibleCount;
    if (nextOffset >= currentOffset || visibleCount === 0) return previousOffset;
    previousOffset = nextOffset;
  }
  return 0;
}

function transcriptPosition(
  entries: readonly RenderableTranscriptEntry[],
  visible: readonly RenderableTranscriptEntry[],
): string {
  const first = visible[0];
  const last = visible[visible.length - 1];
  if (first === undefined || last === undefined) return "0";
  let start = 0;
  let end = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const id = entries[index]?.id;
    if (id === first.id) start = index + 1;
    if (id === last.id) {
      end = index + 1;
      break;
  }
  }
  return `${start}–${end}`;
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
/**
 * Build the `color` prop for an Ink `<Text>` element when colorization is
 * enabled. Under `exactOptionalPropertyTypes`, passing `color: undefined`
 * to a prop typed as optional but not `undefined` is rejected; spreading
 * an empty object omits the prop entirely while preserving the same
 * visual output when color is enabled.
 */
function inkColorProp(
  enabled: boolean,
  color: string,
): { readonly color: string } | Record<string, never> {
  return enabled ? { color } : {};
}

export interface TerminalCapabilities {
  readonly columns: number;
  readonly rows: number;
  readonly color: boolean;
}

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

const ACTION_VIEWPORT_ROWS: Readonly<Record<CompactnessTier, number>> = {
  full: 6,
  standard: 5,
  compact: 6,
  minimal: 6,
};

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
  const SIDEBAR_WIDTH = 24;
  return Math.max(1, caps.columns - (isWideTerminal(caps) ? SIDEBAR_WIDTH : 0));
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
  const tier = compactnessTier(caps);
  const wide = isWideTerminal(caps);
  const sidebarRows = wide ? 0 : 1;
  const missionCardRows =
    tier === "full" ? 8 : tier === "standard" ? 4 : tier === "compact" ? 4 : 0;
  const quickCommandsRows = tier === "full" ? 2 : 0;
  const footerRows = tier === "full" ? 2 : 0;
  const fixed =
    2 +
    sidebarRows +
    missionCardRows +
    quickCommandsRows +
    footerRows +
    chrome.contextActionRows +
    2;
  // Ink clears the entire terminal when output height is equal to the viewport.
  // Keep one safety row so keystroke updates stay on its in-place render path.
  return Math.max(0, caps.rows - fixed - 1);
}

const SECTION_ICONS: Readonly<Record<string, { readonly icon: string; readonly accent: Accent }>> =
  {
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
    availability === "disabled" ? COLORS.muted : focused || selected ? COLORS.text : COLORS.muted;
  return (
    <Box>
      <Text {...inkColorProp(colorize, markerColor)}>{markers}</Text>
      <Text> </Text>
      <Text {...inkColorProp(colorize, labelColor)} bold={focused}>
        {label}
      </Text>
      <Text> </Text>
      <Text {...inkColorProp(colorize, COLORS[accent])}>{icon}</Text>
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
  readonly paneWidth?: number;
  readonly viewportRows?: number;
}

export function ContextActions({
  actions,
  selectedIndex = -1,
  focused = false,
  colorize = true,
  compact = false,
  paneWidth = 80,
  viewportRows,
}: ContextActionsProps) {
  if (actions.length === 0 && viewportRows === undefined) {
    return (
      <Box flexDirection="column" marginTop={compact ? 0 : 1}>
        <SectionLabel label="Actions" />
        <Text color={COLORS.muted}>No actions available.</Text>
      </Box>
    );
  }
  const selected =
    actions.length === 0 ? -1 : Math.max(0, Math.min(selectedIndex, actions.length - 1));
  const visibleActions = actionWindow(actions, selected, paneWidth, compact, viewportRows);
  const position =
    visibleActions.length < actions.length ? ` ${selected + 1}/${actions.length}` : "";
  return (
    <Box flexDirection="column" marginTop={compact ? 0 : 1}>
      <SectionLabel label={`Actions${position}`} />
      <Box
        borderStyle={compact ? undefined : "round"}
        borderColor={COLORS.borderSoft}
        flexDirection="column"
        paddingX={1}
        paddingY={0}
        marginTop={compact ? 0 : 1}
        height={viewportRows === undefined ? undefined : viewportRows + (compact ? 0 : 2)}
        overflowY={viewportRows === undefined ? undefined : "hidden"}
      >
        {visibleActions.length === 0 ? (
          <Text color={COLORS.muted}>No actions available.</Text>
        ) : (
          visibleActions.map((action) => {
            const index = actions.indexOf(action);
            const row: NavigationRowState = {
              focused: focused && selected === index,
              selected: selected === index,
              availability: action.availability.status === "enabled" ? "enabled" : "disabled",
            };
            const markers = navigationRowMarkers(row);
            const isDisabled = action.availability.status === "disabled";
            const commandColor = isDisabled ? COLORS.muted : COLORS.cyan;
            return (
              <Box key={action.id} flexDirection="column">
                <Box>
                  <Text {...inkColorProp(colorize, isDisabled ? COLORS.red : COLORS.text)}>
                    {markers}
                  </Text>
                  <Text> </Text>
                  <Text {...inkColorProp(colorize, COLORS.muted)} bold={row.focused}>
                    {action.label}
                  </Text>
                </Box>
                <Box marginLeft={4}>
                  <Text {...inkColorProp(colorize, commandColor)}>{action.command}</Text>
                </Box>
                {isDisabled ? (
                  <>
                    <Box marginLeft={4}>
                      <Text {...inkColorProp(colorize, COLORS.muted)}>
                        {action.availability.reason}
                      </Text>
                    </Box>
                    {action.availability.recoveryCommand === undefined ? null : (
                      <Box marginLeft={4}>
                        <Text {...inkColorProp(colorize, COLORS.muted)}>
                          {action.availability.recoveryCommand}
                        </Text>
                      </Box>
                    )}
                  </>
                ) : null}
              </Box>
            );
          })
        )}
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
    const selector = items[selectedIndex] ?? items[0];
    if (selector === undefined) return null;
    const position = items.indexOf(selector) + 1;
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
        paddingX={1}
      >
        <NavItem
          icon={selector.meta.icon}
          label={`${selector.section.label} ${position}/${items.length}`}
          focused={selector.state.focused}
          selected={selector.state.selected}
          availability={selector.state.availability}
          accent={selector.meta.accent}
          colorize={capabilities.color}
        />
        <Text>{"  "}</Text>
        <Text color={COLORS.muted}>
          <Text color={COLORS.text}>↑↓</Text> move
        </Text>
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

export function MissionCard({
  title,
  description,
  suggestions,
  compact = false,
}: MissionCardProps) {
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
  readonly transcriptOffsetEntries?: number;
  /**
   * Renderable transcript entries with plain-text row metadata. The shell
   * displays one contiguous page selected by `transcriptOffsetEntries`;
   * callers keep the complete bounded history and control navigation.
   */
  readonly entries?: readonly RenderableTranscriptEntry[];
  readonly children?: ReactNode;
}
function TranscriptEntryLine({ entry }: { readonly entry: RenderableTranscriptEntry }) {
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
  transcriptOffsetEntries = 0,
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
  // The action pane reserves a tier-specific number of body rows regardless
  // of the active category. ContextActions windows around the selected row,
  // so changing categories cannot move the prompt or discard the selected
  // action's disabled recovery guidance.
  const viewport = transcriptViewport(capabilities, contextActions);
  const paneWidth = viewport.paneWidth;
  const actionViewportRows = ACTION_VIEWPORT_ROWS[tier];
  const measuredEntries =
    entries?.map((entry) => ({
      ...entry,
      rows: estimateEntryRows(entry.text, entry.kind, paneWidth),
    })) ?? null;
  const historyRows = measuredEntries !== null && measuredEntries.length > 0 ? 1 : 0;
  const transcriptBudget = Math.max(0, viewport.rowBudget - historyRows);
  const structuredEntries =
    measuredEntries !== null
      ? windowTranscriptPage(measuredEntries, transcriptBudget, transcriptOffsetEntries)
      : null;
  const historyPosition =
    measuredEntries === null || structuredEntries === null
      ? "0"
      : transcriptPosition(measuredEntries, structuredEntries);
  const allChildren =
    structuredEntries !== null
      ? structuredEntries.map((entry) => <TranscriptEntryLine key={entry.id} entry={entry} />)
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
                paneWidth={paneWidth}
                viewportRows={actionViewportRows}
              />
            </Box>
          ) : null}
          {entries !== undefined && entries.length > 0 ? (
            <Box paddingX={1}>
              <Text color={COLORS.muted}>
                History {historyPosition} / {entries.length} · PgUp/PgDn · End
              </Text>
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
