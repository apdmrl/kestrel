# Changelog

## Unreleased (post-0.1.0 review fixes)

- GitHub browser authentication: `kestrel auth login`, `kestrel auth status`, and
  `kestrel auth logout --confirm github.com`, plus `/auth login`, `/auth status`, and
  `/auth logout` in the persistent shell. Authentication is now a deliberate action instead
  of a side effect of the first command that needs GitHub.
- GitHub device-flow login now uses Kestrel's production OAuth client ID by default. Set a
  non-empty `GITHUB_CLIENT_ID` to use a custom OAuth app; empty or whitespace-only values use
  the production default.
- The device-flow verification URI is opened in the user's browser automatically. The URI and
  user code are still printed first, so a failed or slow launch never blocks authentication.
  Suppress the launch with `--no-browser`, `KESTREL_NO_BROWSER`, or `--json`.
- Browser launches fail closed: only `https:` URLs with a real host and no embedded userinfo
  are opened, so a hostile `GITHUB_API_URL` cannot direct Kestrel at `javascript:`, `file:`,
  `data:`, or a `https://github.com@evil.example/` impersonation.
- Device-flow guidance is now a view model delivered through a callback rather than a raw
  stderr write, so the Ink session renders it in the transcript instead of tearing the frame.
- The persistent shell now keeps every frame shorter than the terminal viewport, avoiding
  full-screen clears on each keystroke. Batched Enter input clears the prompt correctly, and
  authentication configuration failures retain their actual setup action instead of collapsing
  to a circular `Run /auth login` message.
- Persistent-shell `/help` now renders one command per line, and the packaged POSIX executable
  includes a Node shebang so clean npm installs launch correctly.
- Persistent-shell navigation has one visible focus owner as movement shifts between
  the prompt, sidebar, and contextual actions; the terminal-aware layout keeps frame
  and prompt geometry stable while navigating.
- Recommendations now include the source repository, issue number, type, language,
  URL, a readable issue-description summary, and Kestrel's selection reasons.
- The persistent shell hydrates its current-mission card from durable state and
  updates it immediately after accept, prepare, resume, complete, and abandon results.
- Transcript history now uses contiguous pages with `PageUp`, `PageDown`, and `End`
  navigation instead of mixing selected older output into the live command result.
- GitHub Find sends its alternative labels as a GitHub OR label query and fetches only
  the configured bounded page budget.
- An empty Find result clears any prior recommendation, including its stale accept action.
- `auth status` validates the stored token against GitHub and never mutates credentials;
  `auth logout` refuses without an explicit confirmation because it clears the shared
  `github.com` credential that `git` and `gh` also read.

- Cross-platform release gate: build cleanup and the recovery barrier are now portable Node
  helpers (no `rm -rf`, `mkfifo`, `bash`, or `timeout`), the fake Git test seam is a Node shim,
  packaged-bin tests resolve the Windows `.cmd` shim, and the CI matrix runs Node 24 on
  Ubuntu, macOS, and Windows.
- `mission break-lock` now derives and verifies a trusted mission location inside the managed
  workspace root (rejecting traversal, symlinks, root escape, and conflicting recovery
  sources) before deleting any lock.
- Legacy recommendation migration is serialized by an atomic claim: the legacy file is renamed
  to an owned staging name, deleted only after the snapshot is durably confirmed, restored on
  failure, and orphaned staging is recovered on the next bootstrap.
- GitHub authentication cancellation is end to end: the signal reaches cached-token validation
  and the device-flow HTTP request, so a hang aborts cleanly (exit 130) with no credential
  mutation.
- Git predicate probes (`isAvailable`, `branchExists`, `commitExists`) rethrow cancellation
  instead of misclassifying it as `false`.
- A single transaction cancellation commit point is defined: journal-intent creation is the
  point of no return, and a completed mutation is never forced to exit 130.
- Malformed process lock identities fail closed (never authorize a live-lock break).
- Added SIGTERM acceptance coverage and the reproducible recovery repeat harness
  (`scripts/repeat-recovery.mjs`).

## 0.1.0

- Local-first terminal CLI for discovering, preparing, and recording open-source engineering challenges.
- GitHub-only challenge source with device-flow authentication.
- Recoverable mission preparation and transactional state/Journey updates.
- Deterministic structured AgentBrief and immutable handoffs.
- Plain and JSON output with interactive Ink flows.
- `mission break-lock --id <missionId>` to recover a stale lock left by a crashed process, running before journal replay and refusing live locks.
- Graceful `SIGINT`/`SIGTERM` cancellation propagated through device polling, discovery, verification, and Git/process execution (classified, exit 130).
- Lock ownership uses stable Linux process identity (boot id + `/proc/<pid>/stat` start ticks) to detect OS pid reuse.
- Automatic, identity-safe migration of the legacy single-latest recommendation into the per-id layout.
