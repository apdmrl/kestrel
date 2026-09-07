# Terminal Navigation and Find Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make keyboard navigation visually deterministic and make `/find` return real GitHub candidates without leaving stale recommendations after an empty search.

**Architecture:** Keep Ink input/focus/layout policy in `cli/interactive`, discovery planning in `application`, and GitHub query/pagination effects in `infrastructure`. Reuse the existing reducer as the single navigation state owner, preserve the current synchronous command-admission invariant, and keep plain/JSON view-model contracts unchanged.

**Tech Stack:** TypeScript 5.6, React 18, Ink 5, Octokit 4, Vitest 3.

**Spec:** Approved review and repair design in the 2026-09-07 task conversation; no separate spec file.

## Global Constraints

- No complete redesign, Ink replacement, new persistent schema, or new terminal key convention.
- Preserve current uncommitted work committed as `df54577`, especially the one-row Ink viewport reserve, synchronous admission, prompt clearing, cancellation, and interactive auth recovery.
- One authoritative focus value must drive both input routing and focus markers.
- Up/Down navigation must remain visible and spatially understandable at wide and compact terminal sizes.
- A single admitted command may invoke its handler at most once.
- GitHub label synonyms are alternatives, not cumulative requirements.
- `pageBudget` bounds requested pages; every external request receives the caller's `AbortSignal`.
- Plain and JSON output contracts remain unchanged; legitimate empty discovery still renders `No challenge found`.
- Preserve layer boundaries from `AGENTS.md` and do not install or test target repositories.

---

### Task 1: Deterministic terminal navigation and geometry

**Files:**
- Modify: `src/cli/interactive/session.tsx`
- Modify: `src/cli/interactive/session-state.ts`
- Modify: `src/cli/interactive/dashboard.tsx`
- Test: `src/cli/interactive/session.test.tsx`
- Test: `src/cli/interactive/session-state.test.ts`
- Test: `src/cli/interactive/dashboard.test.tsx`

**Interfaces:**
- Consumes: `SessionState.focus`, `selectedSectionIndex`, `selectedActionIndex`; `SECTION_SELECTED`, `ACTION_SELECTED`, `FOCUS_CHANGED`, and `HOME_SELECTED` events; `TerminalCapabilities`.
- Produces: reducer-owned navigation state, `actionFocused={reducerState.focus === "actions"}`, visible compact focus, and a bounded action viewport whose height does not move the prompt while categories change.

- [ ] **Step 1: Add failing exclusive-focus tests**

Use the real `FakeInkStdin` harness at `80×24`. Send Down twice from the prompt to select Find. Assert exactly one `>` focus marker and that it belongs to Find; the action remains selected but not focused. Send Enter and assert focus moves exclusively to the first action.

```ts
expect((frame.match(/>/gu) ?? [])).toHaveLength(1);
expect(frame).toMatch(/>\*-\s+Find/u);
expect(frame).not.toMatch(/>\*-\s+Find a challenge/u);
```

Run: `npm test -- --run src/cli/interactive/session.test.tsx -t "keeps exactly one visible focus owner"`

Expected: FAIL because prompt-to-sidebar currently also sets `actionFocused`.

- [ ] **Step 2: Add failing compact-navigation and stable-frame tests**

At `59×24` and `80×19`, assert the first arrow produces a visible focused section label/marker. At `80×24`, navigate Home → Find → Mission → Agent with transcript entries and assert both total frame height and the prompt row remain stable.

Run: `npm test -- --run src/cli/interactive/session.test.tsx src/cli/interactive/dashboard.test.tsx -t "compact navigation|stable prompt row"`

Expected: FAIL because compact navigation drops focus/labels and ContextActions has variable height.

- [ ] **Step 3: Move navigation ownership into the reducer**

Remove local `selectedCategoryIndex`, `focus`, `selectedActionIndex`, and `actionFocused` state. Seed the reducer from `initialCategory` without importing terminal navigation definitions into the reducer. Dispatch existing navigation events from the one primary input handler and derive render props from `reducerState`.

```ts
const selectedCategoryIndex = reducerState.selectedSectionIndex;
const focus = reducerState.focus;
const selectedActionIndex = reducerState.selectedActionIndex;
// ...
actionFocused={focus === "actions"}
```

Keep disabled-action Enter as a no-op, action activation as prompt fill, modulo Up/Down movement, synchronous admission, and busy cancellation unchanged.

- [ ] **Step 4: Make compact navigation visibly vertical and bound actions**

Render compact Sidebar items as a short vertical list or a single labeled selector controlled by Up/Down; it must expose both selected and focused state. Give the action area a tier-specific fixed height with `overflowY="hidden"`, window around `selectedActionIndex`, and reserve that fixed height in `availableTranscriptRows`. Show a concise position indicator when actions are omitted from the window. Reuse display-cell row measurements; do not add a second sizing convention.

- [ ] **Step 5: Run focused navigation tests**

Run: `npm test -- --run src/cli/interactive/session-state.test.ts src/cli/interactive/session.test.tsx src/cli/interactive/dashboard.test.tsx`

Expected: PASS with no warnings.

- [ ] **Step 6: Commit**

```bash
git add src/cli/interactive/session.tsx src/cli/interactive/session-state.ts src/cli/interactive/dashboard.tsx src/cli/interactive/session.test.tsx src/cli/interactive/session-state.test.ts src/cli/interactive/dashboard.test.tsx
git commit -m "fix(ui): stabilize keyboard navigation"
```

### Task 2: Correct bounded GitHub discovery

**Files:**
- Modify: `src/application/discovery/discovery-planner.ts`
- Modify: `src/infrastructure/github/github-challenge-source.ts`
- Test: `src/application/discovery/discovery-planner.test.ts`
- Test: `src/infrastructure/github/github-challenge-source.test.ts`

**Interfaces:**
- Consumes: `DiscoveryPlan.batches`, `DiscoveryBatch.pageBudget`, `SearchQuery.labels/topics/language`, `ChallengeSource.search(intent, signal)`.
- Produces: GitHub OR-label query encoding, bounded multi-page traversal, normalized-candidate deduplication, and cancellation propagation.

- [ ] **Step 1: Add a failing OR-label query test**

Capture the Octokit `GET /search/issues` options and assert one qualifier encodes policy labels as alternatives, for example `label:"bug","bug-fix","good first issue"`, rather than three separate `label:` qualifiers. Assert preferred language remains present.

Run: `npm test -- --run src/infrastructure/github/github-challenge-source.test.ts -t "treats policy labels as alternatives"`

Expected: FAIL because `buildQuery` emits one qualifier per label.

- [ ] **Step 2: Add failing page-budget, deduplication, and cancellation tests**

Return page-specific fake responses. Assert pages `1..pageBudget` are requested only until enough normalized candidates are collected, `per_page` is a fixed provider batch size rather than `pageBudget`, repeated issues are emitted once, and the same `AbortSignal` is passed to every request.

Run: `npm test -- --run src/infrastructure/github/github-challenge-source.test.ts -t "page budget|deduplicates|signal"`

Expected: FAIL because the adapter requests only page 1 with `per_page: pageBudget`.

- [ ] **Step 3: Implement provider-correct query construction**

Keep `SearchQuery` provider-neutral. In the GitHub adapter, escape quoted label values and emit one comma-separated `label:` qualifier for alternatives. Do not require every topic alongside every label; apply a topic only when no label hint exists, so hints narrow without making synonym sets impossible.

- [ ] **Step 4: Implement bounded page traversal**

Use a fixed `per_page` value sized for candidate collection, iterate `page` from 1 through `batch.pageBudget`, stop on an empty/short response or once the application enrichment budget can be satisfied, normalize each issue, deduplicate by stable provider identity/canonical URL, and propagate mapped errors/cancellation exactly as today.

- [ ] **Step 5: Run focused discovery tests**

Run: `npm test -- --run src/application/discovery/discovery-planner.test.ts src/application/discovery/find-challenge.test.ts src/infrastructure/github/github-challenge-source.test.ts`

Expected: PASS with no warnings.

- [ ] **Step 6: Commit**

```bash
git add src/application/discovery/discovery-planner.ts src/application/discovery/discovery-planner.test.ts src/infrastructure/github/github-challenge-source.ts src/infrastructure/github/github-challenge-source.test.ts
git commit -m "fix(discovery): broaden bounded GitHub search"
```

### Task 3: Clear stale recommendation after empty Find

**Files:**
- Modify: `src/cli/interactive/session.tsx`
- Modify: `src/cli/interactive/session-state.ts`
- Test: `src/cli/interactive/session.test.tsx`
- Test: `src/cli/interactive/session-state.test.ts`

**Interfaces:**
- Consumes: parsed `SessionCommand.kind`, `SessionControllerResult`, matching operation IDs.
- Produces: typed reducer event `FIND_COMPLETED_EMPTY` carrying the matching operation ID; no new public `ViewModel` variant or JSON field.

- [ ] **Step 1: Add a failing reducer test**

Start with a successful recommendation, start a later Find operation, dispatch `FIND_COMPLETED_EMPTY` for that operation, and assert the operation becomes idle and `latestRecommendation` becomes null. Assert a stale operation ID is ignored.

Run: `npm test -- --run src/cli/interactive/session-state.test.ts -t "clears a recommendation after an empty Find"`

Expected: FAIL because the event does not exist.

- [ ] **Step 2: Add a failing interactive behavior test**

Return a recommendation from the first `/find` and `{kind:"verification", text:"No challenge found"}` from the second. Assert the second result remains visible but `/mission accept --id <old-id>` disappears from contextual actions.

Run: `npm test -- --run src/cli/interactive/session.test.tsx -t "removes stale accept action after empty Find"`

Expected: FAIL because generic operation success preserves `latestRecommendation`.

- [ ] **Step 3: Implement typed empty-Find transition**

Add `FIND_COMPLETED_EMPTY` to `SessionEvent`. In `Session.submit`, use the already parsed command kind and controller result to dispatch it only when a Find command returns the handler's verification result; otherwise retain `OPERATION_SUCCEEDED`. The reducer must validate the running operation ID before clearing state. Do not inspect rendered text and do not change shared view models.

- [ ] **Step 4: Run focused state and session tests**

Run: `npm test -- --run src/cli/interactive/session-state.test.ts src/cli/interactive/session.test.tsx src/cli/interactive/session-navigation.test.ts`

Expected: PASS with no warnings.

- [ ] **Step 5: Commit**

```bash
git add src/cli/interactive/session.tsx src/cli/interactive/session-state.ts src/cli/interactive/session.test.tsx src/cli/interactive/session-state.test.ts
git commit -m "fix(ui): clear stale empty find results"
```

### Task 4: End-to-end verification and cleanup

**Files:**
- Modify if required by actual behavior: `CHANGELOG.md`
- Remove: any throwaway smoke scripts created during verification

**Interfaces:**
- Consumes: built `dist/cli/main.js`, fake stdin/stdout harness, GitHub adapter fakes.
- Produces: observed behavioral evidence for navigation, Find, output parity, and repository quality.

- [ ] **Step 1: Run built-CLI smoke behavior**

Build, launch the actual CLI in a PTY with isolated `KESTREL_HOME`/workspace and controlled terminal dimensions, exercise Up/Down/sidebar/actions and `/find`, and capture the visible frame. Confirm one focus owner, stable frame/prompt geometry, one Find invocation, and actionable recommendation or truthful empty state.

- [ ] **Step 2: Run repository checks**

```bash
npm run boundaries
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build
npm run check:runtime
```

Expected: every command exits 0 with no unexpected warning/error output.

- [ ] **Step 3: Update changelog only with verified behavior**

Record the navigation-state, stable-layout, GitHub search, and stale-result fixes in the existing changelog format. Do not claim unsupported Home/End behavior.

- [ ] **Step 4: Remove verification scaffolding and commit**

```bash
git add CHANGELOG.md
git commit -m "docs: record terminal navigation and find fixes"
```
