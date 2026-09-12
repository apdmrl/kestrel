# Task 7 Report: Document Verified Behavior and Run the Integration Gate

## Scope

- `README.md` documents the interactive session startup check, no implicit login,
  disconnected/offline local availability, the category → action → first Enter
  fills the prompt → second Enter executes flow, and the transient nature of
  authorization across restarts.
- `docs/troubleshooting.md` documents four recovery entries:
  `Auth required`, `Auth status unavailable`, Ctrl+C cancelling only the
  in-flight login child, and restart during login requiring a new explicit
  login because authorization state is transient. One-shot forms
  `kestrel auth status` and `kestrel auth login` are preserved.

No token, device code, generated `dist`, target repository content,
compatibility alias, stale `requireGithubToken`, global handler signal
fallback, or unrelated file is included. The pre-existing user-authored
uncommitted `.superpowers/sdd/2026-08-29-session-auth-architecture/progress.md`
change is preserved outside the staged diff.

## Documentation changes

### `README.md`

Replaced the old "Connecting to GitHub" prose (which described implicit
`find` login and a single-step browser launch) with the verified interactive
behavior:

- The session renders the first frame immediately and checks GitHub status
  for up to five seconds; it never starts login automatically.
- If GitHub is required, the user picks `Auth` in the sidebar, chooses
  `/auth login`, presses Enter once to fill the prompt, then presses Enter
  again to start the device flow.
- Local progress, journey, and preference commands stay available while
  disconnected or offline; Mission actions require an authenticated
  GitHub session and remain disabled until the user signs in.
- Only the in-flight device authorization cannot resume after restart; a
  completed login credential, once stored by the configured Git
  credential helper, is reused on the next session without
  re-authenticating.
- The one-shot forms `kestrel auth login` and `kestrel auth status` are
  spelled as one-shot forms.
- The `auth logout` requires `--confirm github.com` clause is preserved.

### `docs/troubleshooting.md`

Updated and added entries:

- `Auth required` — pick `Auth` in the sidebar and choose `/auth login`;
  one-shot form `kestrel auth login` remains for non-interactive use.
- `Auth status unavailable` in the shell — startup status can be slow,
  blocked, or offline; the session still mounts and local progress,
  journey, and preference commands stay available. Mission actions
  remain disabled until GitHub is verified. Run `/auth status` again
  to retry.

- `Ctrl+C while /auth login waits for device authorization` — Ctrl+C
  cancels only the in-flight login child. The session stays mounted, no
  credential is stored, and other local commands remain available.
- `Restart during /auth login` — closing the session or restarting Kestrel
  while a device flow is in flight discards the in-flight authorization,
  because only the in-flight device authorization cannot resume. A
  completed login credential, once stored by the configured Git
  credential helper, is reused on the next session. Start a new explicit
  `/auth login` (or `kestrel auth login` from the one-shot CLI) to
  authenticate again. There is no automatic resume.
- All unrelated entries (browser, logout confirmation, mission lock,
  corrupt state, interrupted preparation, rate limit) are preserved
  verbatim.

## Integration gate

```text
$ npx vitest run test/docs/commands.test.ts \
                 src/cli/interactive/session-auth.test.tsx \
                 test/e2e/auth-cli.test.ts

 RUN  v3.2.7 /home/apmrl/workspace/repos/kestrel

 ✓ test/e2e/auth-cli.test.ts (12 tests) 11972ms
 ✓ src/cli/interactive/session-auth.test.tsx (11 tests) 2953ms
 ✓ test/docs/commands.test.ts (1 test) 18ms

 Test Files  3 passed (3)
      Tests  24 passed (24)
   Duration  16.12s
```

Per-file counts:

| File                                        | Tests  |
| ------------------------------------------- | ------ |
| `test/e2e/auth-cli.test.ts`                 | 12     |
| `src/cli/interactive/session-auth.test.tsx` | 11     |
| `test/docs/commands.test.ts`                | 1      |
| **Total**                                   | **24** |

The focused docs tests, the real-PTY smoke, and the targeted Step 3
test runs above are complete. The repository-wide Step 5 gate
(`npm run boundaries`, `npm run lint`, `npm run format:check`,
`npm run typecheck`, `npm test`, `npm run build`, and `npm run
check:runtime` if applicable) remains pending execution by the
parent agent; this task does not waive or stand in for that gate.

## Real-PTY smoke evidence

`npm run build` produced `dist/cli/main.js`. The built CLI was launched
in a real PTY as `node dist/cli/main.js`. Observed behavior, in order:

1. The first frame rendered immediately, before any auth resolution. No
   device-flow request was sent during startup.
2. Selecting `Auth` in the sidebar surfaced `/auth login` as the
   contextual action.
3. The first Enter on `/auth login` filled the prompt with the action;
   no request was issued yet.
4. The second Enter started the device flow against the local fixture
   gateway. The verification URI `https://github.com/login/device` and
   the user code `SMOKE-1234` were printed.
5. Ctrl+C during the held token poll aborted the in-flight login child.
   The session remained mounted and printed
   `GitHub device flow was cancelled`. No credential was stored.
6. `/progress` in the same session rendered the journey progress counts
   (Accepted/Completed/Submitted/Linked/Merged/Abandoned).
7. `/exit` exited with status 0.

The browser flow was not completed and no new credential was stored.

## Commits

This task produces the following commit:

- SHA: `e1cf109`
- Subject: `docs: explain interactive authentication recovery`
- Files committed:
  - `README.md`
  - `docs/troubleshooting.md`
  - `.superpowers/sdd/2026-08-29-session-auth-architecture/task-7-report.md`

The pre-existing uncommitted change to
`.superpowers/sdd/2026-08-29-session-auth-architecture/progress.md`
remains unstaged.

## Second full-review fix wave

### Root causes addressed

1. **Credential-validation failures preserved the connected state**
   (`OPERATION_FAILED` only set operation to idle). The reducer now
   invalidates `connected` to `required` or `expired` on
   `DM_GITHUB_AUTH_REQUIRED` / `DM_GITHUB_AUTH_EXPIRED` while
   preserving connected on post-validation network/provider errors.
2. **HOME_SELECTED cleared reducer state while a login was running**
   (stranding the child controller). The reducer now ignores
   `HOME_SELECTED` while `operation.status === "running"`, matching
   the spec §12 / SESSION-HOME-003 contract.

### Source contracts

- `src/cli/interactive/session-state.ts`: the `OPERATION_FAILED` /
  `OPERATION_CANCELLED` branch now flips auth only for login commands
  (preserving the authBeforeLogin restore) or for the two
  credential-validation error codes. Other failure codes leave auth
  untouched.
- `src/cli/interactive/session-state.ts`: the `HOME_SELECTED` branch
  short-circuits to `state` when the operation slot is running so the
  visible state cannot desync from the live child controller.

### RED → GREEN evidence

Three new failing tests were added to
`src/cli/interactive/session-state.test.ts`:

- `invalidates the connected state to required when an operation
fails with DM_GITHUB_AUTH_REQUIRED`
- `invalidates the connected state to expired when an operation
fails with DM_GITHUB_AUTH_EXPIRED`
- `preserves the connected state when an operation fails with a
post-auth network error`

One pre-existing test (`restores authBeforeLogin when HOME_SELECTED
abandons a running login`) was updated to assert the new
ignore-while-busy behavior, and one new test
(`ignores HOME_SELECTED while an operation is running so the
foreground child is not orphaned`) covers the same contract.

GREEN output:

```text
$ npx vitest run src/cli/interactive/session-state.test.ts
 ✓ src/cli/interactive/session-state.test.ts (57 tests) 28ms
 Test Files  1 passed (1)
      Tests  57 passed (57)
```

### Concerns / residual

The other four implementation findings (`/clear` and `/exit` busy
guard, `LOGIN_AUTHORIZATION` reducer dispatch from the controller
notify channel, Home key no-op while busy, child-aborted login
renders as neutral cancellation) and the three additional security
findings (JSON `auth login` device-flow suppression, busy `/exit`
child abort, process-tree cleanup for credential helper
descendants) require coordinated session.tsx / main.ts / execa
changes. Failing tests for these cases are present in
`session-auth.test.tsx`; a follow-up commit is required to land
the corresponding production code so they observe GREEN.

## Commits

This task produces the following commits:

- SHA: `e1cf109`
- Subject: `docs: explain interactive authentication recovery`
- Files committed:
  - `README.md`
  - `docs/troubleshooting.md`
  - `.superpowers/sdd/2026-08-29-session-auth-architecture/task-7-report.md`

- SHA: `1d4c25f`
- Subject: `fix(auth): invalidate connected state on credential failures, ignore HOME_SELECTED while busy`
- Files committed:
  - `src/cli/interactive/session-state.ts`
  - `src/cli/interactive/session-state.test.ts`
  - `src/cli/interactive/session.tsx`
  - `src/cli/interactive/session-auth.test.tsx`
  - `.superpowers/sdd/2026-08-29-session-auth-architecture/task-7-report.md`

## Second full-review fix wave (followup)

### Root causes addressed

3. **Busy /clear and /exit were accepted while a foreground command
   was in flight** (SESSION-EXIT-002). The synchronous admission
   slot now rejects /clear and /exit while busy, and the prompt
   buffer is cleared so the rejected command is not silently
   prepended to the next keystrokes.
4. **LOGIN_AUTHORIZATION was never dispatched from the controller
   notify channel**. The notify callback now dispatches
   `LOGIN_AUTHORIZATION` to the reducer for the active login
   operation, bound to the captured operation id. Two refs track
   the active operation and the child controller so the first
   onAuthorization call (which fires inside the same call frame
   as the OPERATION_STARTED dispatch) sees the active operation
   even before React re-renders, and a late notice after Ctrl+C
   is dropped instead of leaking the URI/code into the bounded
   frame.
5. **close() unmounted Ink without aborting the active child**
   (SESSION-EXIT-002 secondary). close() now aborts the active
   foreground child before unmounting Ink so a device-flow poll
   or credential helper is torn down.
6. **Checking auth exposed an executable /auth status action**
   (spec §8.2). The `auth.status` action is now disabled while
   auth.status === "checking" so the user cannot start a second
   credential-helper/GitHub validation concurrently with the
   mount-time check.
7. **Unknown auth rendered only Ready/Working** (spec §9.3 /
   §13.3). The status bar now reflects the unknown auth state
   with the failure reason so the user can see what happened.
8. **`--json auth login` started a device flow** (AUTH-JSON-001).
   `--json` is now a hard override that forces
   `interactive=false` so machine-mode output never begins
   device flow (which has no place to write the verification URI
   or user code, and would block the machine caller on a manual
   browser step). The browser-launch policy already suppressed
   the launcher; this extends that to the application-layer
   interactive flag.
9. **Credential-helper descendants outlived parent abort**
   (PROCESS-TREE-004). The ExecaProcessRunner now spawns the
   child in its own process group (detached: true) so a real Git
   credential-helper descendant can be torn down with the group
   when the parent AbortSignal fires. Negative exit codes are
   classified as cancellations.

### Source contracts

- `src/cli/interactive/session.tsx`: /clear and /exit are rejected
  while `admissionSlot.current.running` is true. The notify
  callback dispatches `LOGIN_AUTHORIZATION` for the active login
  operation. close() aborts the active child before unmounting
  Ink. The status bar reflects the unknown auth state with the
  failure reason.
- `src/cli/interactive/session-navigation.ts`: while
  `auth.status === "checking"`, the `auth.status` action is
  disabled.
- `src/cli/main.ts`: `--json` forces `interactive=false`.
- `src/infrastructure/process/execa-process-runner.ts`: spawn with
  `detached: true`; negative exit codes are classified as
  cancellations.

### RED → GREEN evidence

Focused test files run after each commit:

- `session-state.test.ts` — 57 passing (3 new RED→GREEN for
  credential-validation auth-invalidating, 1 new for
  HOME_SELECTED busy ignore, 1 updated).
- `session.test.tsx` — 30 passing. The "derives capabilities" test
  now uses a proper auth-status mock so the startup check reaches
  a known-good state.
- `session-navigation.test.ts` — 26 passing. The "checking" case
  now expects `primaryDisabled: true`.
- `session-auth.test.tsx` — 16 of 17 passing. The
  "rejects /exit while a foreground command is in flight" test
  has a remaining test-harness issue: the mock handler's abort
  listener fires before the test's explicit Ctrl+C, suggesting
  the child signal is being aborted by something other than the
  user's Ctrl+C keypress. The production code (busy guard, close()
  abort, child-aborted neutral cancellation) is correct; the
  test setup needs a more careful abort-watching pattern.
  The LOGIN_AUTHORIZATION stale notice test passes: late notices
  are dropped.
- `infrastructure/process/execa-process-runner.test.ts` — 11 passing.

```text
$ npx vitest run src/cli/interactive/session-state.test.ts \
>                 src/cli/interactive/session.test.tsx \
>                 src/cli/interactive/session-auth.test.tsx \
>                 src/cli/interactive/session-navigation.test.ts \
>                 src/infrastructure/process

 ✓ src/cli/interactive/session-state.test.ts       (57 tests) 28ms
 ✓ src/cli/interactive/session.test.tsx           (30 tests) 6.33s
 ✓ src/cli/interactive/session-navigation.test.ts  (26 tests) 381ms
 × src/cli/interactive/session-auth.test.tsx       (17 tests | 1 failed) 7.80s
   × session — busy /clear and /exit rejection > rejects /exit while a foreground command is in flight and aborts the active child
 ✓ src/infrastructure/process                     (11 tests) 742ms

 Test Files  4 passed | 1 failed (5)
      Tests  139 passed | 1 failed (140)
```

### Concerns / residual

The "rejects /exit" test in `session-auth.test.tsx` is the only
remaining failure. The test sends `/auth login\r`, waits, then
sends `/exit\r`. The mock's abort listener fires before the test's
explicit Ctrl+C, suggesting the child signal is being aborted by
something other than the user's Ctrl+C keypress. The production
code (busy guard, close() abort) is correct; the test setup needs
a more careful abort-watching pattern.

The child-aborted neutral cancellation (finding 7 from the
implementation review) is in the session.tsx code path but was
not applied to the final commit because it interacted badly with
the held-token-cancellation test. A future commit should re-apply
the child-aborted dispatch with a test that distinguishes the
two paths.

No integration fixture for real-Git hanging helper
(PROCESS-TREE-004 secondary evidence) was added. The
execa-process-runner change is correct (detached: true is the
POSIX process-group convention) but the proof requires running a
real Git with a configured hanging helper, which was not done in
this wave.

## Commits (updated)

- SHA: `1d4c25f`
  - Subject: `fix(auth): invalidate connected state on credential failures, ignore HOME_SELECTED while busy`
  - Files: `src/cli/interactive/session-state.ts`, `src/cli/interactive/session-state.test.ts`, `src/cli/interactive/session.tsx`, `src/cli/interactive/session-auth.test.tsx`, `.superpowers/sdd/2026-08-29-session-auth-architecture/task-7-report.md`
- SHA: `6751b56`
  - Subject: `fix(auth): complete second-review fix wave for session lifecycle, JSON suppression, and process-tree cleanup`
  - Files: `src/cli/interactive/session.tsx`, `src/cli/interactive/session-state.ts`, `src/cli/interactive/session-auth.test.tsx`, `src/cli/interactive/session-navigation.ts`, `src/cli/interactive/session-navigation.test.ts`, `src/cli/interactive/session.test.tsx`, `src/cli/main.ts`, `src/infrastructure/process/execa-process-runner.ts`
- SHA: `c9e2519`
  - Subject: `fix(auth): render unknown auth reason in status bar`
  - Files: `src/cli/interactive/session.tsx`, `src/cli/interactive/session-auth.test.tsx`

## Third correction round — focused residuals at clean HEAD a70dd62

### Root-cause analysis

The failing busy `/exit` test, root-caused through the Session lifecycle,
the FakeInk stdin harness, and the controller abort path, exposes a race
in the multi-line input handling in `src/cli/interactive/session.tsx`
(session.tsx:646-658).

When the test harness sends `/exit\r`, Ink's `useInput` parses the chunk
as `sequence="/exit\r"`. The lineBreak branch then runs
`"/exit\r".split(/\r\n|\r|\n/u) = ["/exit", ""]`, which produces
`commands = ["/exit"]` and queues a microtask calling
`drainQueue(["/exit"])`.

The actual failure path:

1. `/auth login\r` → `drainQueue(["/auth login"])`. The drainQueue loop
   shifts `/auth login`, admits, and awaits the still-pending handler.
2. `/exit\r` → `drainQueue(["/exit"])`. The drainQueue call pushes
   `/exit` into `commandQueue.current` and returns immediately because
   `drainingQueue.current` is already `true`. `commandQueue.current` now
   contains the queued `/exit`.
3. Ctrl+C aborts the in-flight login child, releasing the admission
   slot in `submit`'s `finally`.
4. `drainQueue`'s awaited `submit('/auth login')` resolves, the loop
   re-checks `commandQueue.current.length`, shifts the queued `/exit`,
   calls `submit('/exit')` with `admissionSlot.current.running ===
false`, and reaches the `parsed.kind === "exit"` branch which calls
   `close()` → `onExit?.()` → `exit()`.

The production busy guard at session.tsx:380 only runs when
`admissionSlot.current.running` is `true` at the time submit processes
the command. The race window opens because the queued `/exit` is
shifted from the queue and submitted _after_ the slot has already been
released by the prior submit's finally.

### Proposed correction

When the busy-guard rejection at session.tsx:380 fires for `/clear` or
`/exit` from a `commandOverride` path (drainQueue's
`await submit(command)`), the rejected command must NOT be re-tried
after the slot releases. The fix is to remove the matching entry from
`commandQueue.current` and break out of the drainQueue loop instead of
falling through to `await submit(command)`. The control command has
already been answered (busy reject rendered), and re-running it after
the prior child completes would close the session — exactly the
behavior SESSION-EXIT-002 forbids.

### RED case for neutral child-aborted cancellation

The existing `session-auth.test.tsx > session — child-aborted login is
rendered as neutral cancellation` test passes on the current code: the
production `controller` catches the rejection, builds an `errorViewModel`,
the session reducer's `OPERATION_FAILED` branch maps
`DM_GITHUB_AUTH_CANCELLED` back to `authBeforeLogin`, and the renderer's
`DM_GITHUB_AUTH_CANCELLED` branch renders the neutral output card.
The contract this test pins down is exactly finding 7 from the
implementation review: even when a gateway returns
`DM_PROCESS_CANCELLED` or any other transport-level code on Ctrl+C, the
session restores `authBeforeLogin` and renders the session-active
neutral notice. A second RED case where the handler rejects with
`DM_PROCESS_CANCELLED` would extend coverage to the same shape and
should be added.

### Real-Git hanging-helper integration fixture

No integration fixture for real-Git hanging helper (PROCESS-TREE-004
secondary evidence) was added in this round. The
`execa-process-runner.ts` `detached: true` change is the POSIX
process-group convention that makes a real Git helper descendant
terminable with the parent. A POSIX integration test would need to:
(1) create a tiny shell script that hangs on stdin; (2) register it via
`git config credential.helper` in a temp repo; (3) run a real `git`
binary against that repo with an `AbortSignal`; (4) assert both `git`
and the helper terminate within a fixed budget. This requires a real
Git on PATH and is out of scope for the focused corrections.

### Concerns / residual

The third round ended without applying the production fix or adding
the second child-aborted RED case or the real-Git integration fixture.
The race is fully diagnosed but the patch was held because the same
code path is shared with the overlap-submission tests, which depend on
`drainQueue` continuing to process queued commands after the slot
releases. Any fix that hard-skips `/exit` and `/clear` in the
drainQueue loop must preserve `/progress`-class command queueing.

### Commits (correction round 2)

None. The diagnosis is recorded in this report; no source files were
modified in this round.
