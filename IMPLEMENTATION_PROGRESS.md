# Kestrel v0.1 Implementation Progress

> This file tracks the **release-blocker remediation** pass described in
> `docs/kestrel/prompts/deepseek-kestrel-release-blockers.md`, executed strictly RED → GREEN
> on top of the earlier final-review and post-review passes. The complete Node 24 gate exits
> zero; known limitations are listed explicitly below.

Current phase: release-blocker remediation — complete
Current verification: green — `npm ci`, `check:runtime`, boundaries, lint, format:check,
typecheck, `npm test` (**525 tests across 75 files, zero failures, zero skipped, exit 0**),
build, `npm pack --dry-run` (417 files), `npm audit` (0 vulnerabilities) and
`npm audit --omit=dev` (0 vulnerabilities) all pass under Node v24.19.0 / npm 11.17.0.

## Release-blocker remediation tasks

- [x] Task 1 — Stable Linux process identity for lock ownership. Liveness compares the
      recorded `bootId` (`/proc/sys/kernel/random/boot_id`) and `/proc/<pid>/stat` field 22
      start ticks (parsed safely past the command field), never filesystem or wall-clock
      timestamps. Exact identity match is live; mismatch is stale; legacy identity-less
      records remain readable (live pid conservative, absent pid stale).
- [x] Task 2 — `mission break-lock` reachable before journal replay. `--id` is mandatory;
      the exact invocation skips replay, resolves the target via validated index data or a
      validated matching pending intent (rejecting conflicting locations), and recovers the
      mission and the global index lock while refusing every live lock. A later normal
      command performs replay.
- [x] Task 3 — Graceful cancellation propagated end to end. `SIGINT`/`SIGTERM` abort a shared
      signal that terminates in-flight GitHub device polling, discovery, verification, and
      Git/process execution (via the underlying fetch/exec cancel signal), each exiting 130
      with a classified error and no partial state. Cancellation is also checked immediately
      before final state/transaction commits.
- [x] Task 4 — Exact recovery boundaries proven. A FIFO barrier (active only under
      `NODE_ENV=test` with dedicated env vars; production no-op) pauses after each of the
      seven persisted preparation checkpoints and after each of the three transaction phases
      (`PREPARED`, `STATE_WRITTEN`, `EVENT_APPENDED`), each interrupted by a real crash,
      recovered via the product `break-lock`, resumed, and asserted to converge with
      at-most-once side effects. The matrix passed three consecutive runs.
- [x] Task 5 — Package integration gate stabilized with an explicit 60s hook timeout; both
      packaged-binary tests remain enabled and pass under full-suite contention.
- [x] Task 6 — Legacy recommendation migration made identity-safe and observable. The
      migration validates envelope id equals the reconstructed challenge id, removes the
      legacy file only after an identical snapshot is confirmed installed, preserves
      inconsistent/conflicting legacy evidence, and reports non-fatal diagnostics on stderr
      (never JSON stdout).

## Final-review remediation tasks (prior pass)

- [x] Task A — Product CLI stale-lock recovery (`mission break-lock`), live-lock refusal.
- [x] Task B — Process identity in lock liveness (superseded by the stable boot-id/start-ticks
      design in release-blocker Task 1).
- [x] Task C — Graceful `SIGINT`/`SIGTERM` preparation cancellation (superseded by the
      end-to-end propagation in release-blocker Task 3).
- [x] Task D — Honest recovery-matrix tests and documentation.
- [x] Task E — Legacy single-latest recommendation migration (superseded by release-blocker
      Task 6).

## Verification

- Node v24.19.0, npm 11.17.0 (see `.nvmrc`; `npm run check:runtime` fails clearly below Node 24)
- `npm ci`: clean install, 0 vulnerabilities
- `npm run boundaries`: pass
- `npm run lint`: pass
- `npm run format:check`: pass
- `npm run typecheck`: pass
- `npm test`: 525 passed across 75 files, **exit 0** (no failures, no skipped package tests),
  including 34 `test/e2e/workflows.test.ts` scenarios
- `npm run build`: pass
- `npm pack --dry-run`: pass (417 files)
- `npm audit`: 0 vulnerabilities; `npm audit --omit=dev`: 0 vulnerabilities
- CLI smoke checks (`node dist/cli/main.js`): `--help`, `mission --help`,
  `mission break-lock --help`, `agent --help`, `verify --help` all exit 0
- `git diff --check`: clean

## Known limitations (unresolved by design, documented honestly)

- Workspace containment is not race-free against a _concurrent local attacker_: Node.js
  exposes no directory-handle-relative, no-follow creation primitive (no `mkdirat`/openat),
  so a parent replaced in the final check-to-create window can redirect one directory
  creation outside the root. Kestrel detects the escape canonically, classifies it as
  `DM_UNSAFE_PATH`, leaves the empty artifact, and never runs cleanup through a replaced
  parent. See `docs/security.md`.
- The pull-request matcher treats head-branch names as supporting context only; a PR on a
  different head branch does not produce a rejection (the gateway never fetches the PR head
  branch). The CLI-level tests document this contract rather than asserting a rejection.
- On platforms without a `/proc` interface (macOS, Windows), the lock liveness probe cannot
  read a process start identity, so it falls back to a signal-zero check and cannot detect OS
  pid reuse. A stale lock there still requires `mission break-lock`, but a recycled pid may
  be treated as alive until the lock is manually recovered. See `docs/security.md`.
- Graceful cancellation terminates in-flight external calls via the fetch/exec cancel
  signal; a second `SIGINT`/`SIGTERM` forces an immediate exit. `SIGKILL` remains a
  crash path whose stale lock is recovered with `mission break-lock`.

## Blockers

- None.
