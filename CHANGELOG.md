# Changelog

## Unreleased (post-0.1.0 review fixes)

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
