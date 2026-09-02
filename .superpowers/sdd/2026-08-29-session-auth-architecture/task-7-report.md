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
- Local mission, progress, journey, and preference commands stay available
  while disconnected or offline.
- Authorization is transient: a restart requires a new explicit login, and
  the session does not resume an in-flight device flow across restarts.
- The one-shot forms `kestrel auth login` and `kestrel auth status` are
  spelled as one-shot forms.
- The `auth logout` requires `--confirm github.com` clause is preserved.

### `docs/troubleshooting.md`

Updated and added entries:

- `Auth required` — pick `Auth` in the sidebar and choose `/auth login`;
  first Enter fills the prompt, second Enter starts the device flow. The
  one-shot form `kestrel auth login` remains for non-interactive use.
- `Not sure whether you are connected` — preserved verbatim (one-shot
  `kestrel auth status` spelling retained).
- `Auth status unavailable` in the shell — startup status can be slow,
  blocked, or offline; the session still mounts and local mission,
  progress, journey, and preference commands stay available. Run
  `/auth status` again to retry.
- `Ctrl+C while /auth login waits for device authorization` — Ctrl+C
  cancels only the in-flight login child. The session stays mounted, no
  credential is stored, and other local commands remain available.
- `Restart during /auth login` — closing the session or restarting Kestrel
  while a device flow is in flight discards the in-flight authorization,
  because authorization state is transient. Start a new explicit
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

No full suite, lint, typecheck, format:check, boundaries, build, or
`check:runtime` was run for this task per the brief.

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

- SHA: `a0b8f6d`
- Subject: `docs: explain interactive authentication recovery`
- Files committed:
  - `README.md`
  - `docs/troubleshooting.md`
  - `.superpowers/sdd/2026-08-29-session-auth-architecture/task-7-report.md`

The pre-existing uncommitted change to
`.superpowers/sdd/2026-08-29-session-auth-architecture/progress.md`
remains unstaged.