# Kestrel Persistent Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent Ink session to Kestrel so bare `kestrel` accepts slash commands, renders a Matrix-green transcript with a fixed prompt, and exits cleanly with `/exit`, without changing existing one-shot behavior.

**Architecture:** Keep the session in the CLI presentation/controller layer. A typed parser accepts slash commands, a controller maps them explicitly to the existing `CommandHandlers`, and the Ink session renders `ViewModel` results through the existing ANSI-free plain renderer. `main.ts` selects session mode only for a bare invocation; Commander remains the one-shot path for argument-bearing invocations.

**Tech Stack:** TypeScript, Node.js >=24, Ink 5, React 18, Commander 12, Vitest 3, ink-testing-library.

**Spec:** `docs/superpowers/specs/2026-08-25-kestrel-persistent-shell-design.md`

## Global Constraints

- Preserve the `domain → application → ports → infrastructure → cli → bootstrap` dependency direction.
- Never execute arbitrary shell text from a slash command or input line.
- Bare `kestrel` enters session mode; argument-bearing invocations remain on the existing Commander path.
- Preserve `--json`, `--no-interactive`, plain output, cancellation, lock, journal, recovery, and mission lifecycle contracts.
- `/clear` changes only visual in-memory transcript state; `/exit` and `/quit` write no durable mission or recovery state.
- Idle Ctrl+C clears the current input; Ctrl+C during a handler aborts the active operation through the existing `AbortSignal`.
- Do not add GitHub authentication, persistent session schema, arbitrary shell execution, mission transitions, or a JSON session renderer.
- Do not run formatters, linters, or the full suite inside parallel implementation slices; validate once at integration boundaries.

---

## File map

**Create:**

- `src/cli/interactive/session-parser.ts` — typed slash-command grammar, tokenizer, and parser errors.
- `src/cli/interactive/session-parser.test.ts` — parser behavior and rejection tests.
- `src/cli/interactive/session-controller.ts` — explicit mapping from parsed commands to `CommandHandlers` and session-local actions.
- `src/cli/interactive/session-controller.test.ts` — handler mapping, error conversion, and session-local command tests.
- `src/cli/interactive/session-view-models.ts` — transcript/session presentation types and ViewModel-to-transcript conversion.
- `src/cli/interactive/session.tsx` — Ink session lifecycle, input, transcript, prompt, theme, and cancellation wiring.
- `src/cli/interactive/session.test.tsx` — Ink rendering and interaction tests.

**Modify:**

- `src/cli/main.ts` — select session mode for a bare invocation while retaining Commander for all argument-bearing invocations.
- `src/cli/main.test.ts` or the nearest existing main-entry test location — verify mode selection and exit behavior if a suitable entry seam exists.
- `src/cli/interactive/components.test.tsx` — only if shared component test setup must be extended; do not move unrelated tests.
- `test/e2e/` or the nearest existing CLI smoke test file — exercise the built process with `/help`, `/progress`, and `/exit`.

---

### Task 1: Define and test the slash-command grammar

**Files:**
- Create: `src/cli/interactive/session-parser.ts`
- Test: `src/cli/interactive/session-parser.test.ts`

**Interfaces:**
- Produces `SessionCommand`, a discriminated union for session-local commands and handler commands.
- Produces `SessionParseError`, an error with a user-facing message and optional usage text.
- Exports `parseSessionCommand(input: string): SessionCommand | SessionParseError`.
- The controller consumes the union; the Ink component consumes parser errors without importing Commander.

- [ ] **Step 1: Write failing tests for session-local commands.**

Test these exact cases:

```ts
expect(parseSessionCommand("/help")).toEqual({ kind: "help" });
expect(parseSessionCommand("/clear")).toEqual({ kind: "clear" });
expect(parseSessionCommand("/exit")).toEqual({ kind: "exit" });
expect(parseSessionCommand("/quit")).toEqual({ kind: "exit" });
```

Also assert that `progress`, `find`, and `mission current` produce typed handler commands, and that `progress` without a leading slash returns a parse error.

- [ ] **Step 2: Run the focused parser test and verify it fails.**

Run: `npx vitest run src/cli/interactive/session-parser.test.ts`

Expected: FAIL because the parser module and exported types do not exist.

- [ ] **Step 3: Write the tokenizer and typed command union.**

Implement a small tokenizer that:

- trims surrounding whitespace;
- requires the first non-whitespace character to be `/`;
- splits unquoted whitespace-separated tokens;
- supports single- and double-quoted values with the quote characters removed;
- rejects unterminated quotes;
- treats `--name value` as an option pair and rejects a missing value;
- rejects unknown options in the command-specific parser;
- never evaluates, interpolates, or executes token content.

Represent handler commands with exact typed payloads matching `CommandHandlers`:

```ts
type SessionCommand =
  | { readonly kind: "help" }
  | { readonly kind: "clear" }
  | { readonly kind: "exit" }
  | { readonly kind: "find"; readonly mood: string; readonly type?: string }
  | { readonly kind: "mission-current"; readonly missionId?: string }
  | { readonly kind: "mission-accept"; readonly recommendationId: string }
  | { readonly kind: "mission-prepare"; readonly missionId?: string }
  | { readonly kind: "mission-resume"; readonly missionId?: string }
  | { readonly kind: "mission-complete"; readonly missionId?: string }
  | { readonly kind: "mission-abandon"; readonly missionId?: string; readonly reason: string }
  | { readonly kind: "mission-break-lock"; readonly missionId: string }
  | { readonly kind: "agent-brief"; readonly missionId?: string; readonly hypothesis?: string }
  | { readonly kind: "verify-submission"; readonly missionId?: string; readonly prNumber: number }
  | { readonly kind: "verify-link"; readonly missionId?: string; readonly prNumber: number }
  | { readonly kind: "verify-merge"; readonly missionId?: string; readonly prNumber: number }
  | { readonly kind: "journey" }
  | { readonly kind: "progress" }
  | { readonly kind: "preferences-get" }
  | { readonly kind: "preferences-set"; readonly language?: string; readonly mode?: string };
```

Use `mood: "QUICK_WIN"` as the same default used by the existing Commander command.

- [ ] **Step 4: Run focused parser tests and verify they pass.**

Run: `npx vitest run src/cli/interactive/session-parser.test.ts`

Expected: PASS, including quoted values, defaults, required values, unknown options, non-slash input, and unterminated quote failures.

- [ ] **Step 5: Commit the parser deliverable.**

```bash
git add src/cli/interactive/session-parser.ts src/cli/interactive/session-parser.test.ts
git commit -m "feat: add persistent shell command parser"
```

---

### Task 2: Map parsed commands to existing handlers

**Files:**
- Create: `src/cli/interactive/session-controller.ts`
- Test: `src/cli/interactive/session-controller.test.ts`

**Interfaces:**
- Consumes `SessionCommand`, `CommandHandlers`, and `ViewModel`.
- Produces `SessionControllerResult`:

```ts
type SessionControllerResult =
  | { readonly kind: "output"; readonly text: string }
  | { readonly kind: "clear" }
  | { readonly kind: "exit" }
  | { readonly kind: "error"; readonly text: string };
```

- Exports `createSessionController(handlers: CommandHandlers): (command: SessionCommand) => Promise<SessionControllerResult>`.

- [ ] **Step 1: Write failing mapping tests with a complete typed handler double.**

Build a `CommandHandlers` test double whose methods record arguments and return representative `ViewModel` values. Assert exact calls for:

```ts
await controller({ kind: "find", mood: "DEEP_DEBUGGING", type: "BUG" });
await controller({ kind: "mission-current", missionId: "m-1" });
await controller({ kind: "verify-submission", missionId: "m-1", prNumber: 42 });
await controller({ kind: "preferences-set", language: "TypeScript", mode: "guided" });
```

Assert `/help` is not sent to handlers, `/clear` returns `{ kind: "clear" }`, and `/exit` returns `{ kind: "exit" }`.

- [ ] **Step 2: Run the focused controller test and verify it fails.**

Run: `npx vitest run src/cli/interactive/session-controller.test.ts`

Expected: FAIL because the controller module does not exist.

- [ ] **Step 3: Implement the explicit handler mapping.**

Call the exact methods from `CommandHandlers`:

```ts
find -> handlers.find({ mood, ...(type !== undefined ? { type } : {}) })
mission-current -> handlers.missionCurrent({ ...(missionId !== undefined ? { missionId } : {}) })
mission-accept -> handlers.missionAccept({ recommendationId })
mission-prepare -> handlers.missionPrepare({ ...(missionId !== undefined ? { missionId } : {}) })
mission-resume -> handlers.missionResume({ ...(missionId !== undefined ? { missionId } : {}) })
mission-complete -> handlers.missionComplete({ ...(missionId !== undefined ? { missionId } : {}) })
mission-abandon -> handlers.missionAbandon({ ...(missionId !== undefined ? { missionId } : {}), reason })
mission-break-lock -> handlers.missionBreakLock({ missionId })
agent-brief -> handlers.agentBrief({ ...(missionId !== undefined ? { missionId } : {}), ...(hypothesis !== undefined ? { hypothesis } : {}) })
verify-* -> matching verification handler with `{ missionId?, prNumber }`
journey -> handlers.journey()
progress -> handlers.progress()
preferences-get -> handlers.preferencesGet()
preferences-set -> handlers.preferencesSet({ language?, mode? })
```

Convert successful `ViewModel` values with `renderPlain`. Convert thrown values using `errorViewModel` followed by `renderPlain`; return an error result instead of rejecting so the session remains mounted.

- [ ] **Step 4: Run the focused controller tests and verify they pass.**

Run: `npx vitest run src/cli/interactive/session-controller.test.ts`

Expected: PASS, including error conversion and all handler mappings.

- [ ] **Step 5: Commit the controller deliverable.**

```bash
git add src/cli/interactive/session-controller.ts src/cli/interactive/session-controller.test.ts
git commit -m "feat: route shell commands to cli handlers"
```

---

### Task 3: Add transcript presentation types and Matrix-green components

**Files:**
- Create: `src/cli/interactive/session-view-models.ts`
- Create: `src/cli/interactive/session.tsx`
- Test: `src/cli/interactive/session.test.tsx`

**Interfaces:**
- `TranscriptEntry` is `{ kind: "input" | "output" | "error" | "system"; text: string; id: number }`.
- `SessionProps` is:

```ts
interface SessionProps {
  readonly handlers: CommandHandlers;
  readonly signal: AbortSignal;
  readonly onExit?: () => void;
}
```

- `Session` is the default or named React component rendered by `ink`.
- The session uses `createSessionController` and `parseSessionCommand`; it does not import Commander or call application services directly.

- [ ] **Step 1: Write failing Ink tests for initial layout and local commands.**

Using `ink-testing-library`, assert:

- the initial frame contains `KESTREL`, `session: ready`, `Type /help`, and `kestrel ›`;
- typing `/help` and pressing Enter adds the command list without unmounting;
- typing `/clear` and pressing Enter removes prior transcript content;
- typing `/exit` and pressing Enter calls `onExit` exactly once;
- typing plain `hello` displays a `/help` hint and does not call a handler.

Use `cleanup()` after each test, matching `src/cli/interactive/components.test.tsx`.

- [ ] **Step 2: Run the focused Ink test and verify it fails.**

Run: `npx vitest run src/cli/interactive/session.test.tsx`

Expected: FAIL because the session component and presentation types do not exist.

- [ ] **Step 3: Implement the session component.**

Use Ink `Box`, `Text`, `useInput`, and `useApp` or equivalent existing Ink conventions. Keep state local to the session:

- transcript entries with a bounded visual history;
- current input buffer;
- `busy` state that prevents a second handler submission while one is running;
- monotonically increasing entry id;
- exit guard so `onExit` fires once.

On Enter:

1. append the input as an `input` transcript entry;
2. parse it;
3. append parser errors as `error` entries without invoking the controller;
4. invoke the controller for valid commands;
5. apply `output`, `clear`, or `exit` result;
6. restore the prompt after the promise resolves.

For `/help`, render a stable concise list of supported commands. For `/clear`, clear transcript state only. For `/exit`/`/quit`, call the exit callback and unmount through the parent path.

Use a Matrix-green palette with readable fallback symbols. Do not rely on color for error/success semantics. Do not use a side panel or fixed-width box.

- [ ] **Step 4: Add cancellation and Ctrl+C behavior tests.**

Add an abort-aware handler promise and assert that Ctrl+C while busy aborts it and returns to a usable prompt. Assert idle Ctrl+C clears input but does not call `onExit`. Assert the session responds to an already-aborted signal without starting another handler.

- [ ] **Step 5: Run focused Ink tests and verify they pass.**

Run: `npx vitest run src/cli/interactive/session.test.tsx src/cli/interactive/components.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit the session UI deliverable.**

```bash
git add src/cli/interactive/session-view-models.ts src/cli/interactive/session.tsx src/cli/interactive/session.test.tsx
git commit -m "feat: add persistent matrix-green shell session"
```

---

### Task 4: Wire bare invocation to the persistent session

**Files:**
- Modify: `src/cli/main.ts`
- Test: nearest existing main-entry test seam, or create a focused test alongside `src/cli/main.ts` only if dependency injection is required by the implementation.

**Interfaces:**
- Preserve `main(): Promise<void>` as the process entrypoint.
- Reuse the already bootstrapped `handlers`, `controller.signal`, and recovery decision.
- Session mode is selected only when `process.argv.slice(2).length === 0`.

- [ ] **Step 1: Write failing mode-selection tests or a narrow seam test.**

Cover these invariants:

argv = []
  -> render the Ink session

argv = ["find", "--no-interactive"]
  -> keep the existing Commander parse path

argv = ["--json", "progress"]
  -> keep the existing Commander JSON path
```

- [ ] **Step 2: Run the focused mode-selection test and verify it fails.**

Run: `npx vitest run src/cli/main.test.ts`

Expected: FAIL if the new selection seam is not yet present. If the repository has no importable main test seam because `main.ts` invokes `void main()` at module load, first extract a small pure `shouldStartSession(args: readonly string[]): boolean` helper and test that helper without changing process behavior.

- [ ] **Step 3: Wire bare invocation to Ink.**

After bootstrap returns handlers, branch only on `process.argv.slice(2).length === 0`:

```ts
if (process.argv.slice(2).length === 0) {
  await render(<Session handlers={handlers} signal={controller.signal} onExit={() => undefined} />);
  return;
}
```

Use the repository's existing Ink render/import convention. Keep the current Commander construction and `parseAsync` path unchanged for every non-empty argument list. Preserve the current recovery bypass for `mission break-lock`, signal listeners, and post-command cancellation exit logic. Make session exit resolve the mounted render promise and allow `main()` to return without setting an error exit code.

- [ ] **Step 4: Run focused CLI tests and verify they pass.**

Run: `npx vitest run src/cli/main.test.ts src/cli/create-program.test.ts`

Expected: PASS, with bare invocation selecting session mode and argument-bearing invocations selecting Commander.

- [ ] **Step 5: Commit the entrypoint wiring.**

```bash
git add src/cli/main.ts src/cli/main.test.ts
git commit -m "feat: launch shell for bare kestrel invocation"
```

---

### Task 5: Add real built-CLI smoke coverage

**Files:**
- Modify: the nearest existing built CLI smoke test in `test/cli-built.test.ts` or `test/e2e/` after inspecting its process helpers.
- Modify: only the smallest test fixture/helper needed to send stdin to a running built process.

**Interfaces:**
- Consumes the built `dist/cli/main.js` entrypoint and existing test process utilities.
- Produces observable coverage for the session/one-shot boundary; it must not install dependencies or run target repository commands.

- [ ] **Step 1: Inspect the nearest existing CLI process test helper and add a failing session smoke case.**

Create a real-process test that launches the built CLI with no arguments, writes these lines to stdin in order, and closes stdin only after `/exit`:

```text
/help
/progress
/exit
```

Assert output contains `KESTREL`, `/help`, `kestrel ›`, and the existing progress labels. Assert the process exits with code `0`.

Add a second case for the existing one-shot boundary using the repository's deterministic fixture/config:

```text
kestrel --no-interactive progress
```

Assert it does not render the session prompt and preserves the established plain/JSON behavior used by neighboring tests.

- [ ] **Step 2: Run the focused smoke test before implementation integration.**

Run: `npm run build && npx vitest run test/cli-built.test.ts`

Expected: the new session smoke test fails until the shell is wired and the built process can consume stdin.

- [ ] **Step 3: Adjust only process lifecycle details required by the smoke test.**

Ensure the session does not leave stdin listeners or timers alive after `/exit`. Do not add a forced timeout or fake output. If the current test helper cannot send interactive stdin, extend that helper with a real child-process stdin write/close path and preserve its existing cleanup.

- [ ] **Step 4: Run the focused smoke test and verify it passes.**

Run: `npm run build && npx vitest run test/cli-built.test.ts`

Expected: PASS for both interactive and one-shot cases.

- [ ] **Step 5: Commit the smoke coverage.**

```bash
git add test/cli-built.test.ts test/e2e
git commit -m "test: smoke test persistent kestrel shell"
```

---

### Task 6: Integration verification and reviewer correction pass

**Files:**
- Modify only files identified by focused test failures or reviewer findings.
- Test: existing focused tests plus repository quality commands.

**Interfaces:**
- Consumes Tasks 1–5 outputs.
- Produces a verified persistent shell with no regression to one-shot CLI behavior.

- [ ] **Step 1: Run all changed-area tests.**

Run:

```bash
npx vitest run \
  src/cli/interactive/session-parser.test.ts \
  src/cli/interactive/session-controller.test.ts \
  src/cli/interactive/session.test.tsx \
  src/cli/interactive/components.test.tsx \
  src/cli/create-program.test.ts \
  test/cli-built.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run applicable repository checks once at the integration boundary.**

Run:

```bash
npm run boundaries
npm run lint
npm run format:check
npm run typecheck
npm run build
npm run check:runtime
```

Expected: PASS. Run `npm test` if the focused and quality checks do not already execute the complete Vitest suite through the repository's configured command.

- [ ] **Step 3: Dispatch a reviewer agent with the exact diff and acceptance criteria.**

The reviewer must inspect architecture boundaries, signal/cancellation behavior, input safety, one-shot compatibility, transcript state growth, and test quality. Reviewer must not run formatters, linters, or the full suite.

- [ ] **Step 4: Dispatch implementation agents for each accepted reviewer finding.**

Each correction agent receives one concrete finding, edits only its owned files, adds or updates the focused behavioral test that demonstrates the correction, and skips project-wide validation.

- [ ] **Step 5: Re-run focused tests and integration checks after corrections.**

Run the changed-area tests first, then repeat the applicable commands from Step 2. Do not claim completion until the actual built CLI smoke scenario passes.

- [ ] **Step 6: Commit the verified integration state.**

```bash
git add src test
git commit -m "feat: complete persistent kestrel shell"
```

## Plan self-review

- **Spec coverage:** Bare invocation, slash commands, transcript/fixed prompt, Matrix-green semantics, parser/controller boundaries, error handling, cancellation, `/clear`, `/exit`, one-shot compatibility, no arbitrary shell execution, bounded visual history, and real-process smoke coverage are covered by Tasks 1–6.
- **Placeholder scan:** No TBD, TODO, fake fallback, or unowned “write tests later” step remains. Any “nearest existing test” instruction is constrained to inspecting the repository's existing process-test seam before creating the smallest required test.
- **Type consistency:** `SessionCommand` is produced by Task 1 and consumed by Task 2; `SessionControllerResult` is produced by Task 2 and consumed by Task 3; `SessionProps` and `TranscriptEntry` are defined in Task 3 and consumed by Task 4; Task 5 consumes the built entrypoint; Task 6 validates all outputs.
- **Scope:** This is one cohesive shell-first sub-project. GitHub authentication remains a separate future design/plan as required by the approved spec.