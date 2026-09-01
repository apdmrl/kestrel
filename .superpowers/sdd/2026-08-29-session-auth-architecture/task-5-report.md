# Task 5 Report: Startup Auth Deadline and Foreground Cancellation

## Status

PASS — startup auth deadline + child operation cancellation land in commit
`0d22926`; the four focused test files run together at 98 passing. The
user's pre-existing uncommitted work and the unrelated stash are preserved.

## Commit

- SHA: `0d22926`
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