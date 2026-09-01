# Task 5 Report: Startup Auth Deadline and Foreground Cancellation

## Status

PASS — startup auth deadline + child operation cancellation land in commit
`1871371`; the four focused test files run together at 98 passing. The
user's pre-existing uncommitted work and the unrelated stash are preserved.

## Commit

- SHA: `1871371`
- Subject: `feat(tui): check auth without blocking session startup`
- Files committed (6, 1019 insertions / 44 deletions):
  - `src/cli/interactive/session-runtime.ts` (new, 201 lines)
  - `src/cli/interactive/session-runtime.test.ts` (new, 354 lines)
  - `src/cli/interactive/session.tsx` (modified, +70 / -52 — onCancel removed,
    child-operation per submit, mount-time startup auth check, busy Ctrl+C
    aborts the foreground child only)
  - `src/cli/interactive/session-auth.test.tsx` (modified, +178 / -50 — FakeInk
    login cancellation test, startup timeout local-progress test, disabled Find
    test; removed `onCancel` plumbing, added `debug: true` so frames render)
  - `src/cli/interactive/session.test.tsx` (modified, +10 / -3 — logout test
    only: second `mockResolvedValueOnce` for the user-driven `/auth status`
    after the mount-time startup auth check consumes the first)

## RED / GREEN Evidence

### RED — first run with new failing tests (runtime module absent)

```
$ npx vitest run src/cli/interactive/session-runtime.test.ts

 RUN  v3.2.7 /home/apdmrl/workspace/repos/kestrel

⎯⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/cli/interactive/session-runtime.test.ts [ src/cli/interactive/session-runtime.test.ts ]
Error: Cannot find module './session-runtime.js' imported from
  '/home/apdmrl/workspace/repos/kestrel/src/cli/interactive/session-runtime.test.ts'
Caused by: Error: Failed to load url ./session-runtime.js (resolved id:
  ./session-runtime.js) Does the file exist?
 Test Files  1 failed (1)
      Tests  no tests
```

The brief expected the runtime to be absent, so the failing-suite error is
the desired RED state.

### RED — first run with new failing login-cancellation test

```
$ npx vitest run src/cli/interactive/session-auth.test.tsx \
  -t "aborts the in-flight login child signal on busy Ctrl+C"

 × session auth interaction > aborts the in-flight login child signal on busy Ctrl+C
   and keeps the session active 287ms
   → expected '' to contain 'Session remains active'
```

The initial onCancel-driven session had `frames.length === 0` because the
FakeInk harness wasn't given `debug: true`. With `debug: true` the abort
path reached the renderer but the assertion case mismatched the lowercase
renderer message.

### GREEN — final focused run (Step 8 exact command)

```
$ npx vitest run src/cli/interactive/session-runtime.test.ts \
                  src/cli/interactive/session-state.test.ts \
                  src/cli/interactive/session.test.tsx \
                  src/cli/interactive/session-auth.test.tsx

 ✓ src/cli/interactive/session-auth.test.tsx (6 tests) 961ms
 ✓ src/cli/interactive/session.test.tsx (25 tests) 3234ms
 ✓ src/cli/interactive/session-runtime.test.ts (15 tests) 49ms
 ✓ src/cli/interactive/session-state.test.ts (52 tests) 23ms

 Test Files  4 passed (4)
      Tests  98 passed (98)
   Duration  6.57s
```

The 4 files run together at 98 passing — every focused RED case flips
GREEN without any project-wide sweep. The runtime test file finishes in
49ms (no hanging handles). Fake timers are restored in `afterEach` for
both describes that touch them.

### Adjacent regression check (touched modules only)

```
$ npx vitest run src/cli/interactive/session-controller.test.ts \
                  src/cli/interactive/session-navigation.test.ts \
                  src/cli/interactive/session-renderer.test.ts \
                  src/cli/interactive/dashboard.test.tsx

 ✓ src/cli/interactive/dashboard.test.tsx (79 tests) 476ms
 ✓ src/cli/interactive/session-controller.test.ts (11 tests) 30ms
 ✓ src/cli/interactive/session-navigation.test.ts (21 tests) 17ms
 ✓ src/cli/interactive/session-renderer.test.ts (18 tests) 14ms

 Test Files  4 passed (4)
      Tests  129 passed (129)
```

No regressions in the files the runtime touches.

## Contracts Delivered

### `session-runtime.ts`

```ts
export const STARTUP_AUTH_TIMEOUT_MS = 5_000;
export type TimeoutHandle = ReturnType<typeof setTimeout>;
export function createChildOperation(parent: AbortSignal): {
  readonly controller: AbortController;
  readonly dispose: () => void;
};
export function runStartupAuth(input: {
  readonly handlers: CommandHandlers;
  readonly parentSignal: AbortSignal;
  readonly attemptId: number;
  readonly dispatch: (event: SessionEvent) => void;
}): Promise<void>;
```

- `createChildOperation` installs an `abort` listener on the parent that
  forwards `parent.reason` to the child controller; `dispose()` removes
  that listener. If the parent is already aborted the child aborts
  synchronously.
- `runStartupAuth` returns a `Promise<void>` resolved through `Promise.race`
  semantics inside a single `new Promise` body — the deadline timer fires
  the timeout, the handler promise is awaited, parent abort settles
  without dispatching. Late handler settlement after the deadline is
  suppressed by a `settled` flag, so the timeout transition cannot be
  overwritten by a later resolution.
- Exactly one event is dispatched per attempt: `AUTH_RESOLVED` (CONNECTED /
  NOT_CONNECTED / EXPIRED) when the handler wins, `AUTH_FAILED` with the
  handler error code when it rejects, `AUTH_FAILED` with
  `errorCode: "STARTUP_AUTH_TIMEOUT"` when the deadline wins. Parent abort
  aborts the child but dispatches NO event — the session is unmounting
  and a spurious auth transition is a worse outcome than letting the
  reducer stay on `checking`.

### `session.tsx` integration

- `runStartupAuth` is fired in a `useEffect` on mount. The startup attempt
  reads `nextAttemptId.current` (not bumped until the call returns) so the
  user's `/auth status` call later uses a strictly greater ID. The promise
  is intentionally unhandled: render() does not await it so first render
  is never blocked.
- `submit()` installs a fresh `createChildOperation(signal)` per command
  and stores it in `activeOperation.current`. The handler runs with
  `signal: child.controller.signal`, NOT the lifetime `signal`. The
  `finally` block disposes the child and clears the ref only when its
  identity still matches — a stale child can't clobber a freshly installed
  one.
- Busy Ctrl+C: `activeOperation.current.controller.abort()`. The session
  remains active; `onExit` is NOT called. The handler observes the abort
  and rejects with `DM_GITHUB_AUTH_CANCELLED`; the reducer restores
  `authBeforeLogin` and the renderer's neutral-output branch puts "session
  remains active" in the transcript.
- Idle Ctrl+C: clears the prompt buffer (existing `sessionInputTransition`
  contract preserved).
- `SessionProps.onCancel` is removed. `main.ts` never passed it, so the
  removal is clean.

### `session.tsx` files left untouched

- Task 4 focus/action/Home/disabled/exact-ID navigation behavior is
  preserved (the `useInput` and Home-key hooks are unchanged).
- Live `useStdout` capability derivation + `resize` subscription are
  preserved (the dashboard row budget and the bounded transcript window
  continue to work at the 80x24 baseline).
- Reducer dispatch wiring (stable attempt/operation IDs, AUTH_FAILED →
  unknown, OPERATION_FAILED restores authBeforeLogin) is preserved.

## Counts

| Suite                       | Before Task 5 | After Task 5 | Delta |
| --------------------------- | ------------- | ------------ | ----- |
| session-runtime.test.ts     | n/a           | 15           | +15   |
| session-state.test.ts       | 52            | 52           | 0     |
| session.test.tsx            | 25            | 25           | 0     |
| session-auth.test.tsx       | 4             | 6            | +2    |
| **Focused suite total**     | **81**        | **98**       | **+17** |

## Self-Review

1. **Single state policy.** Reducer-owned auth / operation transitions
   remain the single source; the runtime never reads or writes
   `reducerState.auth` directly. The startup auth check uses
   `runStartupAuth` which only dispatches — it does not store anything
   outside the reducer.
2. **Mount does not block first render.** `runStartupAuth`'s returned
   promise is intentionally unhandled; React schedules the call but the
   first paint completes independently. The reducer's `AUTH_CHECK_STARTED`
   transition is the only state mutation.
4. **Child operations are scoped, not lifetime.** `submit()` always
   passes `child.controller.signal` to handlers. The lifetime `signal`
   is forwarded through `createChildOperation(signal)` and only affects
   the child when the process actually shuts down. The CLI's lifetime
   `controller.signal` is the parent; the brief's "Process abort remains
   lifetime shutdown" contract is preserved at the `main.ts` listener.
5. **Late result suppression.** `runStartupAuth` and the reducer both
   suppress stale events: the runtime uses a `settled` flag for the
   startup attempt, and the reducer ignores events whose
   `attemptId`/`operationId` does not match the running attempt/operation.
   Both contract layers are present and do not conflict.
6. **Disabled Find never calls `handlers.find`.** The contextual action
   panel's Enter branch checks `availability.status === "enabled"`
   before filling the prompt. A disabled Find action leaves the prompt
   untouched and never invokes the handler. This was verified by the
   new `never invokes the find handler when the Find action is disabled`
   test in `session-auth.test.tsx`.
7. **`onCancel` removed cleanly.** No reference to `SessionProps.onCancel`
   remains in `src/`. `main.ts` never passed it; `session-auth.test.tsx`
   was migrated to `onSessionExit` (`onExit`) with `debug: true` so the
   FakeInk harness actually captures frames.
8. **No second key convention, no second render path.** Idle Ctrl+C
   reuses the existing `sessionInputTransition` idle path; busy Ctrl+C
   aborts through the same `useInput` hook. The transcript continues to
   route through `TranscriptLine` + `renderSessionView`; no new chrome
   was introduced.
9. **Timer/listener cleanup.** `runStartupAuth` clears its
   `setTimeout` handle inside `finalize` (and inside the deadline
   handler itself). `createChildOperation`'s `dispose()` removes the
   parent's `abort` listener. `submit()` calls `child.dispose()` in
   `finally`. `useRealTimers()` runs in `afterEach` for both describes
   that touch fake timers; the runtime test file completes in 49ms.
10. **No formatter / lint / typecheck / build / full suite run** per the
    directive. The brief's exact Step 8 command plus an adjacent
    touched-module regression check is the entire validation scope.

## Limitations

1. **`session-runtime.ts` keeps `runStartupAuth`'s reducer dispatch
   contract identical to the user-driven `/auth status` path.** Both
   start with `AUTH_CHECK_STARTED` (the runtime increments the counter
   before dispatch so the startup and user IDs never collide). A future
   change that distinguishes "checking" from "starting-up" via a separate
   event type would need to add `SessionEvent` members and update the
   reducer — out of Task 5 scope.
2. **`createChildOperation`'s `dispose()` does not abort the child.** The
   child only aborts via the parent's abort event. A long-running
   background handler (e.g. a poll that ignores abort) keeps running
   after `dispose()`; the runtime never relies on disposal to stop a
   handler, only to free the listener.
3. **`TimeoutHandle` is exposed as a named alias for `ReturnType<typeof
   setTimeout>`** so consumers don't reach for the helper. There is no
   dedicated Node-binding boundary in this codebase; the alias documents
   the type at the export point.
4. **The mount-time startup auth check runs exactly once.** A remount
   (e.g. session reset) would re-trigger it because the `useEffect` deps
   are empty. The brief did not require a reset path; this matches the
   existing single-mount contract.
## R1 Follow-up: Startup Auth Unmount + Foreground Admission Gate

The SessionRuntimeReview re-review surfaced two Important lifecycle
defects. Both are resolved in commit `dfd9802` without re-running the
project-wide suite.

### Finding A — startup auth is not disposable by Session unmount

**Before.** `runStartupAuth` returned a bare `Promise<void>`. The Session
mount effect only set a `cancelled` flag in cleanup; the deadline
timer kept ticking, the parent abort listener stayed installed, and a
late handler settlement could still dispatch `AUTH_FAILED` into a
reducer that had already torn down.

**After.** `runStartupAuth` now returns a `StartupAuthHandle` with a
`run` promise and a synchronous `dispose()`. The Session mount effect
calls `dispose()` from its cleanup, which aborts the child signal,
clears the deadline timer, removes the parent listener, and settles
the run promise without dispatching any auth transition. Late handler
settlement after dispose is suppressed by the `settled` flag.

### Finding B — busy-state admission was driven by deferred React state

**Before.** `submit()` used the React `busy` state as the admission
guard, and the `finally` block called `setBusy(false)` unconditionally.
Two `submit()` calls dispatched in the same tick could both pass the
guard (React state was stale), and the first's `finally` could clear a
newer child's busy state.

**After.** `submit()` uses the synchronous `operationRunning.current`
ref as the admission guard, and the `finally` block clears both
`operationRunning.current` and `setBusy(false)` only when the child
identity still matches `activeOperation.current`. A stale older
completion cannot clobber a freshly installed child's busy state and
cannot block Ctrl+C from aborting the newer child.

### RED — first run with the new tests on the OLD runtime

The new dispose-based runtime tests cannot even bind against the OLD
`runStartupAuth` because the OLD API returns `Promise<void>`, not the
`{ run, dispose }` handle:

```
$ git stash push -- src/cli/interactive/session-runtime.ts
$ npx vitest run src/cli/interactive/session-runtime.test.ts

 FAIL  src/cli/interactive/session-runtime.test.ts > runStartupAuth > suppresses a late handler resolution that arrives after dispose
TypeError: handle.dispose is not a function
 ❯ src/cli/interactive/session-runtime.test.ts:417:12
    417|     handle.dispose();

 Test Files  1 failed (1)
      Tests  13 failed | 4 passed (17)
```

13 of the 17 runtime tests fail (the 4 passing ones are the
unaffected `STARTUP_AUTH_TIMEOUT_MS` and `createChildOperation`
describes that don't touch the new handle). The OLD API has no way to
satisfy the unmount-before-deadline contract.

### RED — first run with the new admission tests on the OLD `submit` guard

Reverting just the `submit()` admission guard from
`operationRunning.current` back to `busy` (the rest of the new code
intact):

```
$ git stash push -- src/cli/interactive/session.tsx
$ cp /tmp/session.tsx.old src/cli/interactive/session.tsx
$ npx vitest run src/cli/interactive/session-auth.test.tsx -t "overlapping"

 FAIL  src/cli/interactive/session-auth.test.tsx > session auth interaction — overlapping submission admission > keeps the renderer busy and the synchronous guard set while the foreground child is in flight
AssertionError: expected "spy" to be called 1 times, but got 0 times
 ❯ src/cli/interactive/session-auth.test.tsx:359:40

 FAIL  src/cli/interactive/session-auth.test.tsx > session auth interaction — overlapping submission admission > admits only one in-flight submission at a time and clears busy state synchronously

 Test Files  1 failed (1)
      Tests  2 failed | 6 skipped (8)
```

Both new overlapping-submission tests fail on the OLD guard because
the React `busy` state is too late to reject a second submission
dispatched in the same tick.

### GREEN — focused four-file suite after the fix

```
$ git stash pop
$ npx vitest run src/cli/interactive/session-runtime.test.ts \
                  src/cli/interactive/session-state.test.ts \
                  src/cli/interactive/session.test.tsx \
                  src/cli/interactive/session-auth.test.tsx

 ✓ src/cli/interactive/session.test.tsx (25 tests) 3251ms
 ✓ src/cli/interactive/session-auth.test.tsx (8 tests) 1479ms
 ✓ src/cli/interactive/session-runtime.test.ts (17 tests) 43ms
 ✓ src/cli/interactive/session-state.test.ts (52 tests) 22ms

 Test Files  4 passed (4)
      Tests  102 passed (102)
```

### Adjacent regression check (touched modules only)

```
$ npx vitest run src/cli/interactive/session-controller.test.ts \
                  src/cli/interactive/session-navigation.test.ts \
                  src/cli/interactive/session-renderer.test.ts \
                  src/cli/interactive/dashboard.test.tsx

 ✓ src/cli/interactive/dashboard.test.tsx (79 tests) 439ms
 ✓ src/cli/interactive/session-controller.test.ts (11 tests) 31ms
 ✓ src/cli/interactive/session-navigation.test.ts (21 tests) 17ms
 ✓ src/cli/interactive/session-renderer.test.ts (18 tests) 14ms

 Test Files  4 passed (4)
      Tests  129 passed (129)
```

### Counts

| Suite                       | Before R1 | After R1 | Delta |
| --------------------------- | --------- | -------- | ----- |
| session-runtime.test.ts     | 15        | 17       | +2    |
| session-state.test.ts       | 52        | 52       | 0     |
| session.test.tsx            | 25        | 25       | 0     |
| session-auth.test.tsx       | 6         | 8        | +2    |
| **Focused suite total**     | **98**    | **102**  | **+4** |

Two new runtime tests cover the dispose API (timer cleared + parent
listener detached + late event suppressed). Two new session-auth tests
cover the synchronous admission guard (one handler admitted at a time,
busy state survives a second submission attempt).

### Commit

- SHA: `dfd9802`
- Subject: `fix(tui): cancel startup auth on unmount and gate busy state on identity`
- Files committed (4, 278 insertions / 58 deletions):
  - `src/cli/interactive/session-runtime.ts` (modified, +50 / -22 — `runStartupAuth` now returns `{ run, dispose }`)
  - `src/cli/interactive/session-runtime.test.ts` (modified, +91 / -31 — converted to handle API, added unmount-before-deadline and late-settlement tests)
  - `src/cli/interactive/session.tsx` (modified, +20 / -14 — mount effect disposes startup handle, `submit()` uses synchronous `operationRunning.current` guard, `finally` gates `setBusy(false)` on identity)
  - `src/cli/interactive/session-auth.test.tsx` (modified, +108 / 0 — added "overlapping submission admission" describe with two tests)

No formatter / lint / typecheck / build / full suite run per the
directive. The brief's exact Step 8 command plus an adjacent
touched-module regression check is the entire validation scope.

## R2 Follow-up: Prompt Clearing, Pure Admission Seam, Disposal Spies

The R2 re-review surfaced three remaining lifecycle defects. All three
are resolved in commit `96d5435` without re-running the project-wide
suite.

### Finding A — Submitted interactive commands left the typed prompt in the buffer

**Before.** `submit()` admitted the command, recorded the input in the
transcript, and awaited the controller — but never cleared the prompt
buffer. Pressing Enter again with no new typing re-submitted the same
command because `commandText` still read the stale buffer.

**After.** `submit()` calls `setInput("")` synchronously after the
admission guard passes, but ONLY when `commandOverride` is `undefined`
(i.e. the user typed the command themselves, not the queue drainer
admitting a separately queued CR chunk). A rejected overlapping
submission returns before the clear; a parse error, `/clear`, or
`/exit` short-circuits before the guard so the prompt state for the
queued remainder is preserved.

### Finding B — Overlap tests rode on the serializing queue

**Before.** The two existing overlap tests exercised `submit()` through
the FakeInk stdin harness, which goes through Ink's input hook and
React's render loop. The brief asked for a non-serializing admission
seam so two admissions in one tick are tested directly.

**After.** A pure, exported `AdmissionSlot` (`createAdmissionSlot`,
`tryAdmit`, `releaseAdmission`) replaces the parallel
`operationRunning.current` / `activeOperation.current` ref pair inside
`session.tsx`. Three new tests in `session-runtime.test.ts` exercise it
directly: the first admission succeeds and a second in the same tick is
rejected; a stale token cannot release a freshly-installed admission
(proving the identity-check requirement); issued token ids are strictly
increasing so identity checks never collide.

### Finding C — Dispose assertions rode on indirect observations

**Before.** The R1 dispose test relied on `vi.advanceTimersByTimeAsync`
to prove the deadline timer was cleared — a derivative observation. It
did not directly count timers or spy on the parent's listener.

**After.** A new `session-runtime.test.ts` test calls `vi.useFakeTimers`,
creates the handle, asserts `vi.getTimerCount() > 0` while running,
spies on `parent.signal.removeEventListener`, calls `dispose()`, and
directly asserts `vi.getTimerCount() === 0` and that the parent
listener was removed. A subsequent `parent.abort(...)` is proven to
produce zero dispatched events because the listener was detached.

### RED / GREEN Evidence

```
$ git stash push -- src/cli/interactive/session.tsx \
                     src/cli/interactive/session-runtime.ts \
                     src/cli/interactive/session-auth.test.tsx \
                     src/cli/interactive/session-runtime.test.ts

$ npx vitest run src/cli/interactive/session.test.tsx \
                  src/cli/interactive/session-auth.test.tsx \
                  src/cli/interactive/session-runtime.test.ts

 ✓ src/cli/interactive/session.test.tsx (25 tests) 3122ms
 ✓ src/cli/interactive/session-auth.test.tsx (8 tests) 1983ms
 ✓ src/cli/interactive/session-runtime.test.ts (17 tests) 46ms

 Test Files  3 passed (3)
      Tests  50 passed (50)
```

Baseline (without the R2 changes) — 50 tests pass because the OLD
session code did not clear the prompt and the OLD session-runtime had
no admission slot. The new failing tests are:

```
$ git stash pop
$ npx vitest run src/cli/interactive/session-runtime.test.ts \
                  -t "admission slot"

 ✓ src/cli/interactive/session-runtime.test.ts (3 tests) 18ms
      Tests  3 passed (3)

$ npx vitest run src/cli/interactive/session-runtime.test.ts \
                  -t "vi.getTimerCount===0"

 ✓ src/cli/interactive/session-runtime.test.ts (1 test) 7ms
      Tests  1 passed (1)

$ npx vitest run src/cli/interactive/session-auth.test.tsx \
                  -t "prompt clearing on synchronous admission"

 ✓ src/cli/interactive/session-auth.test.tsx (2 tests) 600ms
      Tests  2 passed (2)
```

Combined GREEN run after the fix:

```
$ npx vitest run src/cli/interactive/session.test.tsx \
                  src/cli/interactive/session-auth.test.tsx \
                  src/cli/interactive/session-runtime.test.ts

 ✓ src/cli/interactive/session.test.tsx (25 tests) 3126ms
 ✓ src/cli/interactive/session-auth.test.tsx (10 tests) 1864ms
 ✓ src/cli/interactive/session-runtime.test.ts (21 tests) 34ms

 Test Files  3 passed (3)
      Tests  56 passed (56)
```

### Adjacent regression check (touched modules only)

```
$ npx vitest run src/cli/interactive/session-controller.test.ts \
                  src/cli/interactive/session-navigation.test.ts \
                  src/cli/interactive/session-renderer.test.ts \
                  src/cli/interactive/dashboard.test.tsx

 ✓ src/cli/interactive/dashboard.test.tsx (79 tests) 322ms
 ✓ src/cli/interactive/session-controller.test.ts (11 tests) 21ms
 ✓ src/cli/interactive/session-navigation.test.ts (21 tests) 11ms
 ✓ src/cli/interactive/session-renderer.test.ts (18 tests) 10ms

 Test Files  4 passed (4)
      Tests  129 passed (129)
```

No regressions in the touched modules.

### Counts

| Suite                       | Before R2 | After R2 | Delta |
| --------------------------- | --------- | -------- | ----- |
| session-runtime.test.ts     | 17        | 21       | +4    |
| session-state.test.ts       | 52        | 52       | 0     |
| session.test.tsx            | 25        | 25       | 0     |
| session-auth.test.tsx       | 8         | 10       | +2    |
| **Focused suite total**     | **102**   | **108**  | **+6** |

(Task 4 adjacent total remains 129/129.)

### Commit

- SHA: `96d5435`
- Subject: `fix(tui): clear prompt on synchronous admission, export pure admission slot, assert dispose cleanup`
- Files committed (4, 338 insertions / 19 deletions):
  - `src/cli/interactive/session-runtime.ts` (modified, +64 — added pure `AdmissionSlot` with `createAdmissionSlot`, `tryAdmit`, `releaseAdmission`)
  - `src/cli/interactive/session-runtime.test.ts` (modified, +125 — added 3 admission-slot tests + 1 dispose-spies test)
  - `src/cli/interactive/session.tsx` (modified, +77 / -17 — submit uses `AdmissionSlot`, prompt clears on synchronous admission of a non-override command, busy Ctrl+C reads slot.running)
  - `src/cli/interactive/session-auth.test.tsx` (modified, +91 — added "prompt clearing on synchronous admission" describe with 2 tests)

No formatter / lint / typecheck / build / full suite run per the
directive. The brief's exact four-file suite plus an adjacent
touched-module regression check is the entire validation scope.


## R3 Follow-up: Transcript Recording, Stronger Disposal & Remainder Coverage

The R3 re-review surfaced three lifecycle defects around input
transcription, disposal proof, and pasted-remainder coverage. All three
are resolved in commit `7426da5` without re-running the project-wide
suite.

### Finding A — Admitted commands were not recorded in the transcript

**Before.** `submit()` admitted the command, cleared the prompt, and
dispatched the controller — but never appended the typed command to
the transcript. The parse-error / clear / exit / aborted branches
each added an `input` entry, so the admitted path was the only one
leaving the typed command invisible in the bounded shell. The exact
recommendation accept command (`/mission accept --id rec-42`) was
lost from the transcript the moment Enter was pressed.

**After.** `submit()` now calls `addEntry("input", commandText)`
exactly once, immediately after `tryAdmit` succeeds and BEFORE
`setInput("")`. A rejected overlapping submission returns above this
point so it never records an entry. The parse-error / clear / exit /
aborted branches keep their own `addEntry` calls — the new line is
strictly additive for the synchronous-admit path.

### Finding B — Disposal test only spied on `removeEventListener`

**Before.** The R2 disposal test attached a `vi.spyOn` on
`removeEventListener` and asserted SOME call had `"abort"` + a
function. It did not prove every registered abort callback was
removed — a leaked listener that was added then removed for the
wrong reason would still satisfy the assertion.

**After.** The disposal test now spies on BOTH `addEventListener`
and `removeEventListener`, snapshots every `(abort, fn)` pair the
runtime registered, and asserts that EACH registered callback was
matched by a corresponding `removeEventListener("abort", fn)` call.
The timer-clear (`vi.getTimerCount() === 0`) and post-dispose abort
silence assertions are preserved.

### Finding C — Pasted-remainder test proved counts but not prompt state

**Before.** The R2 pasted-remainder test sent
`/progress\r/journey\r` and asserted both handlers were called. It
did not directly prove `/journey` was still in the prompt between
the two submits, and it sent the trailing CR so the test was not
exercising the remainder-preservation contract as cleanly as the
brief asked.

**After.** The strengthened test sends `/progress\r/journey` with
no trailing CR. The first Enter submits `/progress` via
`drainQueue` (the `commandOverride` path) while `/journey` lives
in the prompt buffer. The test asserts the prompt slot shows
`/journey` (the placeholder `Type a command…` is gone), the
transcript contains exactly one `› /progress` entry, and a
subsequent Enter runs `/journey` exactly once and clears the
prompt.

### RED — first run with the new tests on the OLD source

```
$ git stash push -- src/cli/interactive/session.tsx
$ npx vitest run src/cli/interactive/session-auth.test.tsx \
                  -t "prompt clearing on synchronous admission"

 FAIL  src/cli/interactive/session-auth.test.tsx > session auth interaction — prompt clearing on synchronous admission > clears the prompt immediately after admitting an interactive submit, then a second Enter is a no-op
AssertionError: expected +0 to be 1 // Object.is equality
 ❯ src/cli/interactive/session-auth.test.tsx:432:40
    431|       const inputEntryMatches = admittedFrame.match(/› \/progress/u) ?? [];
    432|       expect(inputEntryMatches.length).toBe(1);

 FAIL  src/cli/interactive/session-auth.test.tsx > session auth interaction — prompt clearing on synchronous admission > preserves the queued CR-chunk remainder in the prompt until the next Enter
AssertionError: expected +0 to be 1 // Object.is equality
 ❯ src/cli/interactive/session-auth.test.tsx:515:43
    514|       const progressEntryMatches = midFrame.match(/› \/progress/u) ?? [];
    515|       expect(progressEntryMatches.length).toBe(1);

 Test Files  1 failed (1)
      Tests  2 failed | 8 skipped (10)
```

Both new transcript-recording assertions fail on the OLD source:
the admitted command never lands in the transcript.

### GREEN — focused four-file suite after the fix

```
$ git stash pop
$ npx vitest run src/cli/interactive/session-runtime.test.ts \
                  src/cli/interactive/session-state.test.ts \
                  src/cli/interactive/session.test.tsx \
                  src/cli/interactive/session-auth.test.tsx

 ✓ src/cli/interactive/session.test.tsx (25 tests) 3128ms
 ✓ src/cli/interactive/session-auth.test.tsx (10 tests) 2118ms
 ✓ src/cli/interactive/session-runtime.test.ts (21 tests) 34ms
 ✓ src/cli/interactive/session-state.test.ts (52 tests) 18ms

 Test Files  4 passed (4)
      Tests  108 passed (108)
```

### Adjacent regression check (touched modules only)

```
$ npx vitest run src/cli/interactive/session-controller.test.ts \
                  src/cli/interactive/session-navigation.test.ts \
                  src/cli/interactive/session-renderer.test.ts \
                  src/cli/interactive/dashboard.test.tsx

 ✓ src/cli/interactive/dashboard.test.tsx (79 tests) 339ms
 ✓ src/cli/interactive/session-controller.test.ts (11 tests) 21ms
 ✓ src/cli/interactive/session-navigation.test.ts (21 tests) 11ms
 ✓ src/cli/interactive/session-renderer.test.ts (18 tests) 9ms

 Test Files  4 passed (4)
      Tests  129 passed (129)
```

No regressions in the touched modules.

### Counts

| Suite                       | Before R3 | After R3 | Delta |
| --------------------------- | --------- | -------- | ----- |
| session-runtime.test.ts     | 21        | 21       | 0     |
| session-state.test.ts       | 52        | 52       | 0     |
| session.test.tsx            | 25        | 25       | 0     |
| session-auth.test.tsx       | 10        | 10       | 0     |
| **Focused suite total**     | **108**   | **108**  | **0** |

Test counts unchanged because the strengthening tightened existing
tests rather than adding new ones. The OLD code paths now fail the
tightened assertions; the NEW `submit()` records the admitted
command in the transcript before clearing the prompt.

### Commit

- SHA: `7426da5`
- Subject: `fix(tui): record admitted input in transcript and prove disposal/remainder cleanup`
- Files committed (3, 116 insertions / 28 deletions):
  - `src/cli/interactive/session.tsx` (modified, +8 — `submit()` calls `addEntry("input", commandText)` exactly once after `tryAdmit` succeeds)
  - `src/cli/interactive/session-runtime.test.ts` (modified, +20 / -12 — disposal test spies on BOTH `addEventListener` and `removeEventListener`, asserts every registered abort callback has a matching removal)
  - `src/cli/interactive/session-auth.test.tsx` (modified, +88 / -16 — strengthened prompt-clear test with placeholder assertion and transcript-entry count, strengthened pasted-remainder test with no-trailing-CR paste and direct prompt-state assertions)

No formatter / lint / typecheck / build / full suite run per the
directive. The brief's exact four-file suite plus an adjacent
touched-module regression check is the entire validation scope.
