# Kestrel Persistent Shell — Resume Plan

> Resume document for the next implementation session. Read this file together with `docs/superpowers/specs/2026-08-25-kestrel-persistent-shell-design.md` and `docs/superpowers/plans/2026-08-25-kestrel-persistent-shell.md` before editing code.

**Current branch state:** The feature branch was merged locally into `main` as `094e022 feat: add persistent kestrel shell`. The feature worktree/branch was intentionally preserved because final review identified unresolved runtime/acceptance risks.

**Last verified code commit:** `e50503c fix: preserve unfinished pasted shell line`.

## Verified baseline

The merged repository currently has:

- Slash parser and typed `SessionCommand` union.
- Explicit controller mapping to every existing `CommandHandlers` method.
- Matrix-green Ink transcript/prompt UI.
- Bare `kestrel` session selection; argument-bearing calls remain Commander.
- Top-level `/current` and nested `/mission current` support.
- Bounded transcript state and monotonic transcript IDs.
- Multiline input queue that executes complete commands serially and preserves an unfinished final line.
- Existing plain/JSON one-shot behavior preserved by regression tests.

Observed checks:

- `npm run boundaries` — passed.
- `npm run lint` — passed.
- `npm run format:check` — passed.
- `npm run typecheck` — passed.
- `npm run build` — passed.
- `npm run check:runtime` — passed.
- Serial full suite `npx vitest run --maxWorkers=1` — **80 files / 636 tests passed**.
- A supervised PTY smoke started the built CLI and sent `/help`, `/progress`, `/exit`; process exited `0`.

The default parallel `npm test` had one intermittent/concurrency-sensitive failure in `test/e2e/workflows.test.ts` (`keeps both index entries when two child processes update different missions`); the focused test and serial full suite passed.

## Remaining work — ordered tasks

### R1: Make active Ctrl+C operation-scoped

**Problem:** `Session` calls `onCancel` while busy, but `main.ts` currently aborts the process-wide `AbortController` and unmounts Ink. That exits the persistent shell and permanently aborts the signal captured by all bootstrapped handlers. The approved contract requires active cancellation to unwind the current operation and restore a usable prompt; OS-level SIGINT/SIGTERM may still close the process.

**Required design decision:** Introduce an operation/session cancellation boundary without weakening the existing process-level cancellation contract. Do not fake reset an already-aborted `AbortSignal`.

**Likely ownership:**

- `src/cli/main.ts` — separate OS termination handling from session command cancellation.
- `src/bootstrap/index.ts` and/or `src/cli/command-handlers.ts` — expose a safe signal injection/factory boundary only if required; preserve current handler API for one-shot Commander calls.
- `src/cli/interactive/session.tsx` — await cancellation unwind and restore prompt; do not unmount on active command cancellation.
- Focused session/bootstrap tests — pending handler, cancel, unwind, prompt reuse, second command.

**Acceptance:** Busy Ctrl+C aborts only the active operation, the prompt remains mounted, a subsequent command can run, and OS SIGINT/SIGTERM still closes the process gracefully.

### R2: Preserve pre-replay break-lock reachability

**Problem:** Bare `kestrel` has no positional `mission break-lock` signal, so bootstrap recovery replay runs before the session. If stale recovery blocks replay, `/mission break-lock` is unreachable.

**Required design decision:** Preserve fail-closed recovery and the existing one-shot `kestrel mission break-lock --id <id>` bypass. Decide whether the session should expose break-lock only after successful recovery, or whether bootstrap needs a narrowly scoped pre-session recovery route. Do not disable transaction replay for every bare session.

**Likely ownership:**

- `src/cli/main.ts` — startup mode/recovery ordering.
- `src/bootstrap/index.ts` — only if a safe pre-replay route is required.
- `src/cli/interactive/session-parser.ts` and controller — keep/remove session break-lock in alignment with the chosen reachable contract.
- `test/e2e/` — stale lock/replay failure and repair path.

**Acceptance:** A stale lock cannot leave the user with no repair path; recovery remains fail-closed; one-shot break-lock behavior remains unchanged.

### R3: Add rendered Ink input interaction coverage

**Problem:** Current `session.test.tsx` tests the reducer seam and static rendering, but not the actual `ink-testing-library` stdin → `useInput` → rendered session path. Direct fake-stdin probes collapsed the frame to a newline in this environment, so the gap was parked rather than silently ignored.

**Required coverage:**

- `/help` output and mounted prompt.
- `/clear` transcript reset.
- `/exit`/`/quit` exactly-once callback.
- Plain input usage error without handler calls.
- Idle Ctrl+C clears input without exit.
- Busy Ctrl+C cancellation and prompt recovery.
- Already-aborted submission does not invoke a handler.
- Complete and incomplete multiline paste behavior.

**Implementation constraint:** Use a deterministic test-specific stdin/render setup that keeps Ink raw-mode support and frame output alive. Do not replace this with reducer-only assertions.

### R4: Add automated built bare-session PTY smoke

**Problem:** Built CLI regression tests currently cover argument-bearing one-shot behavior, but not a durable CI test for bare session `/help`, `/progress`, `/exit`. Supervised PTY evidence exists, but is not automated.

**Required coverage:**

- Build the CLI.
- Launch bare `dist/cli/main.js` under a real PTY.
- Send `/help`, `/progress`, `/exit` in order.
- Assert banner, prompt, progress labels, and exit code `0`.
- Use an isolated `KESTREL_HOME` and clean it afterward.
- Keep the explicit `kestrel --no-interactive progress` assertion proving the one-shot path has no session prompt.

**Implementation constraint:** Use a Linux-compatible PTY mechanism that works in CI. A pipe is invalid because Ink requires raw mode. Do not add a fake TTY or accept manual-only evidence.

### R5: Re-run full parallel suite and triage concurrency failure

After R1–R4:

```bash
npm run boundaries
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build
npm run check:runtime
```

If the concurrent child-process E2E test fails again while the serial suite passes, capture both child statuses/stderr and determine whether the failure is an existing resource race or a regression from session/bootstrap wiring. Do not mask it by changing test concurrency without root-cause evidence.

## Review gates

For each R task:

1. Add focused behavioral tests before implementation.
2. Run the focused tests.
3. Run a task-scoped reviewer.
4. Fix reviewer findings and perform scoped re-review.
5. Run final whole-branch review after R1–R5.

## Residual decisions recorded

- Active cancellation was not silently “fixed” by resetting an aborted signal; the required operation-scoped boundary remains to be designed.
- Recovery replay was not globally disabled to make `/mission break-lock` appear reachable; fail-closed recovery remains the authority until a safe ordering is implemented.
- Manual/supervised PTY evidence was retained, but not misrepresented as CI coverage.

## Resume command sequence

From the repository root:

```bash
git status --short
git log --oneline -5
# Work on a fresh feature branch from main before R1:
git switch -c feat/kestrel-persistent-shell-resume
```

Read this resume document and the approved spec before dispatching agents. Do not start GitHub authentication work until R1–R5 are resolved or explicitly re-scoped in a new approved design.
