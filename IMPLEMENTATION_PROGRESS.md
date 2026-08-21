# Kestrel v0.1 Implementation Progress

> This file tracks the **general-release-review fix pass** described in
> `docs/kestrel/prompts/deepseek-kestrel-general-review-fixes.md` (KGR-001..KGR-011),
> executed strictly RED → GREEN on top of the earlier release-blocker and final-review
> passes.

Current phase: general-release-review fix pass — in progress

## General-release-review fix tasks (KGR-001..KGR-011)

- [x] **Task 1 / KGR-001 — Make the release gate cross-platform.**
  - RED: `test/portability/portability.test.ts` — asserted the build no longer shells out
    to `rm -rf`, no common E2E/package helper invokes `mkfifo`/`timeout`/`bash`/`/usr/bin/git`,
    the packaged-bin tests resolve the Windows `.cmd` shim, and the CI matrix runs Node 24 on
    Ubuntu/macOS/Windows. Failed with 3 assertions before the fix.
  - GREEN: `npm run build` (now `node scripts/clean.mjs dist && tsc`), `npm run boundaries`,
    `npm run lint`, `npm run format:check`, `npm run typecheck`, and
    `npx vitest run test/portability test/package` all pass.
  - Implementation: added `scripts/clean.mjs` (`fs.rm`), replaced the POSIX FIFO recovery
    barrier with a cross-platform file-gate (`FileRecoveryBarrier`), converted the bash
    fake-git to a Node shim (+ `.cmd` shim), replaced `mkfifo`/`bash`/`timeout` in
    `test/e2e/workflows.test.ts` with file-gate helpers, and made package bin resolution
    select `.cmd` on Windows. Full `test/e2e/workflows.test.ts` (34 scenarios) passes on
    Linux; macOS/Windows CI evidence is pending (no CI access in this session).

- [x] **Task 2 / KGR-002 — Contain stale-lock recovery targets.**
  - RED: `src/infrastructure/recovery/trusted-lock-target.test.ts` — asserted the verifier
    accepts a valid sidecar inside the workspace, rejects a sidecar outside the workspace,
    rejects `..` traversal, rejects a symlink component redirecting elsewhere, and rejects a
    path lexically inside but canonically outside. Failed on a missing module. Plus a built-CLI
    E2E test that rewrites the index to point the sidecar outside the workspace and asserts
    `mission break-lock` fails closed with `DM_UNSAFE_PATH` and never deletes the outside lock.
  - GREEN: `npx vitest run src/infrastructure/recovery/trusted-lock-target.test.ts` (6 tests)
    and the `break-lock` E2E scenarios (4) all pass; typecheck/lint/format clean.
  - Implementation: added `verifyTrustedLockTarget` (resolve/relative containment, `lstat`
    symlink walk, canonical `realpath` re-check) and made `FileMissionLock.breakStaleLock`
    accept an optional expected mission id, failing closed on a mismatched lock. Wired both
    into `bootstrap.missionBreakLock`.

- [x] **Task 3 / KGR-003 — Serialize legacy recommendation migration.**
  - RED: added adversarial tests to `file-system-recommendation-store.test.ts` for an older
    writer replacing `recommendation.json` mid-migration, restore-on-failure then idempotent
    recovery, orphaned-staging recovery on the next bootstrap, and two concurrent migrators
    converging. Failed before the atomic-claim implementation.
  - GREEN: `npx vitest run src/infrastructure/persistence/file-system-recommendation-store.test.ts`
    (13 tests) and the E2E per-id-upgrade scenario pass; typecheck/lint/format clean.
  - Implementation: `migrateLegacyRecommendation` now atomically renames the legacy pathname to
    a uniquely owned `*.staging` file before parsing, deletes only that owned staging file after
    the snapshot is durably confirmed, restores/preserves claimed evidence on failure (never
    overwriting a recreated `recommendation.json`), and recovers orphaned staging files
    idempotently on the next bootstrap.

- [ ] **Task 4 / KGR-004 — Complete authentication cancellation.** (RED → GREEN pending)

- [ ] **Task 5 / KGR-005 — Preserve cancellation through Git predicates.** (RED → GREEN pending)

- [ ] **Task 6 / KGR-006 — Define transaction cancellation commit point.** (RED → GREEN pending)

- [ ] **Task 7 / KGR-007 — Reject every recovery-source conflict.** (RED → GREEN pending)

- [ ] **Task 8 / KGR-008 — Satisfy package contract.** (RED → GREEN pending)

- [ ] **Task 9 / KGR-009 — Fail closed on malformed process identity.** (RED → GREEN pending)

- [ ] **Task 10 / KGR-010 — Add SIGTERM acceptance coverage.** (RED → GREEN pending)

- [ ] **Task 11 / KGR-011 — Make verification claims reproducible.** (RED → GREEN pending)

## Earlier pass: release-blocker remediation

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
