# Kestrel AGENTS.md and Development Workflow Design

## Status

Approved in chat on 2026-08-25. This document defines the scope and acceptance criteria for the root `AGENTS.md`. It does not implement the terminal session or UI.

## Goal

Create a root-level `AGENTS.md` that gives contributors and coding agents a project-specific operating contract for Kestrel. The contract must preserve the existing architecture, security and recovery invariants while giving clear direction for future modern terminal-session work.

## Repository Facts

Kestrel is a Node 24 TypeScript package and CLI. Its current layers are:

- `domain`: pure models, invariants, policies and recommendation signals.
- `application`: task-oriented use cases.
- `ports`: external-boundary interfaces.
- `infrastructure`: filesystem, locking, transactions, Git, GitHub and credential adapters.
- `cli`: Commander commands and Ink/plain/JSON renderers.
- `bootstrap`: composition root for concrete adapters.

The current product already supports resumable missions, sidecar state, atomic persistence, lock and transaction recovery, cancellation, evidence recording, plain output and JSON output. Ink components exist, but there is not yet one persistent terminal-session shell.

## Scope of AGENTS.md

The file will contain these sections:

1. **Project intent** — Kestrel prepares the work; the developer owns the work.
2. **Repository map and dependency direction** — layer responsibilities and forbidden imports.
3. **Non-negotiable invariants** — clone-only behavior, sidecar metadata, state versioning, atomic writes, lock/transaction recovery, cancellation and evidence integrity.
4. **Development workflow** — inspect neighboring patterns first, use LSP for symbol-aware work, keep changes narrow, and preserve caller/test contracts.
5. **Test-flow matrix** — target tests by changed contract, with the repository’s standard verification commands.
6. **Terminal-session direction** — session state must be recoverable and application-owned; themes and rendering remain presentation concerns.
7. **Agent and model routing** — use scout for read-only discovery, reviewer/security-reviewer for review, sonic for mechanical edits, task for multi-file implementation, and designer only for genuinely visual UI questions.
8. **Token-efficiency rules** — narrow reads, parallelize independent investigations, avoid duplicate scans, and validate once at integration boundaries.
9. **Definition of done** — behavioral evidence, targeted tests, applicable quality checks, and explicit residual risks.

No nested agent files, product-code changes, terminal UI implementation, new session persistence schema, or speculative abstractions are in scope.

## Terminal Session Direction

The AGENTS contract will guide later implementation without prematurely specifying a concrete UI framework design:

- Distinguish one-shot command output from a persistent interactive session.
- Keep session state reconstructable from durable mission/application state rather than only React/Ink runtime memory.
- Keep themes, colors, terminal dimensions and key bindings in presentation adapters.
- Expose application results through view models so interactive, plain and JSON renderers share behavior.
- Represent long-running progress using real mission checkpoints; never fabricate progress.
- Treat SIGINT/SIGTERM, session restart and interrupted operations as part of the existing recovery contract.
- Add UI behavior tests at component/state-transition level, then connect them to real CLI smoke or E2E flows.

## Test and Verification Contract

The AGENTS file will recommend:

- Domain/application changes: focused unit and use-case tests.
- Port/infrastructure changes: adapter tests plus failure, cancellation and recovery boundaries.
- CLI/presentation changes: renderer/component tests plus built-CLI smoke coverage.
- State, lock or transaction changes: recovery-projector tests and real-process E2E scenarios.
- Package or portability changes: build, package and portability suites.
- Persistent session/UI changes: component state-transition tests, interactive CLI smoke tests, and plain/JSON behavior parity.

The standard final checks remain the existing npm scripts: `npm run boundaries`, `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm test`, and `npm run build` when packaging/build output is affected.

## Agent Routing and Token Efficiency

Agents must not run formatters, linters or the full suite during parallel implementation slices. Independent read-only investigations may run in parallel; edits to the same file must be serialized. A stronger review model is reserved for architecture, security and recovery decisions; smaller mechanical tasks use lower-cost agents. LSP is required for definitions, references, implementations, renames and code actions whenever the language server supports the target.

## Error Handling and Safety

The AGENTS contract must direct agents to preserve recovery-oriented errors, fail closed on unsafe paths or malformed state, avoid repository-side effects outside the requested change, and never weaken non-interactive or machine-readable output contracts. Claims of completion must cite an observed command or test result.

## Acceptance Criteria

The resulting root `AGENTS.md` is accepted when:

- It accurately reflects the repository’s current architecture and commands.
- It contains the nine scope sections above without inventing unsupported behavior.
- It explicitly protects security, recovery, cancellation, sidecar and renderer boundaries.
- It gives actionable test selection and agent/model-routing guidance.
- It describes terminal-session direction without pretending that session/UI implementation already exists.
- It is concise enough to be loaded as agent context without duplicating the full documentation set.
- The file passes repository formatting checks and its referenced commands are present in `package.json`.
