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

| File                                        | Tests |
| ------------------------------------------- | ----- |
| `test/e2e/auth-cli.test.ts`                 | 12    |
| `src/cli/interactive/session-auth.test.tsx` | 11    |
| `test/docs/commands.test.ts`                | 1     |
| **Total**                                   | **24**|

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