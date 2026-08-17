# State and recovery

Kestrel is local-first. Global state lives in `~/.kestrel`, and each mission's state lives in a sidecar next to the cloned repository.

Persisted state is schema-versioned and written atomically. Corrupt state is backed up before repair. Mission state and Journey ledger changes go through a lock + transaction-intent mechanism: a pending transaction is recovered idempotently on the next startup so that each change produces exactly one final state and one journey event.

If mission preparation is interrupted, rerun the same command to resume; already-completed checkpoints are skipped. See `docs/troubleshooting.md` for recovery actions.
