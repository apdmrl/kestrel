# Changelog

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
