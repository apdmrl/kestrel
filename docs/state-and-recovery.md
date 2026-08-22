# State and recovery

Kestrel is local-first. Global state lives in `~/.kestrel`, and each mission's state lives in a sidecar next to the cloned repository.

Persisted state is schema-versioned and written atomically. Corrupt state is backed up before repair. Mission state and Journey ledger changes go through a lock + transaction-intent mechanism: a pending transaction is recovered idempotently on the next startup so that each change produces exactly one final state and one journey event.

If mission preparation is interrupted, rerun the same command to resume; already-completed checkpoints are skipped. See `docs/troubleshooting.md` for recovery actions.

## Recovery

- `kestrel mission break-lock --id <missionId>` recovers a stale mission lock (and the shared global index lock) left by a crashed process. It requires the mission id, runs **before** journal replay, resolves the target through validated index data or a validated matching pending intent (rejecting conflicting locations), and refuses any live lock. It skips replay; a subsequent normal command performs the pending journal recovery.
- `SIGINT`/`SIGTERM` cancel gracefully: the signal propagates through the device flow, discovery, verification, and Git/process execution, releasing locks, preserving resumable state, and exiting 130 with a classified error. A second signal forces an immediate exit. `SIGKILL` is a crash path whose stale lock is recovered with `mission break-lock`.

## Recovery matrix

- Exact recovery boundaries are proven by a cross-platform file-gate barrier that is a no-op in production and activates only under `NODE_ENV=test` with dedicated env vars (the same mechanism runs on Linux, macOS, and Windows). Seven built-CLI cases each crash immediately after one of the seven persisted preparation checkpoints, and three built-CLI cases each crash immediately after a real accept transaction reaches `PREPARED`, `STATE_WRITTEN`, or `EVENT_APPENDED`; each is recovered via the product `break-lock`, resumed, and asserted to converge with at-most-once side effects (see `test/e2e/workflows.test.ts`).
- The exact recovery matrix is reproducible on demand with `node scripts/repeat-recovery.mjs [count]` (default 3). It runs only the seven-checkpoint and three-transaction scenarios, fails fast on the first failing run, and preserves every run's output under `.recovery-repeat/run-<n>.log`.
- The transaction recovery projector is additionally validated on the exact intermediate disk states a crash leaves behind, kept as clearly named recovery-projector tests rather than interruption E2E.
- Lock ownership uses stable Linux process identity (`bootId` + `/proc/<pid>/stat` start ticks) so OS pid reuse cannot keep an abandoned lock alive; legacy identity-less records remain conservatively readable. See `docs/security.md`.
