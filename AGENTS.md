# Kestrel Agent Guide

## Project Intent

Kestrel is a local-first terminal companion for solving real open-source engineering problems. Kestrel prepares the work; the developer owns the work. Prefer evidence, recoverability and explicit user control over automation that hides decisions.

## Repository Map and Boundaries

Kestrel uses these layers and dependency directions:

- `domain` — pure models, invariants, policies and recommendation signals. It must not import Node APIs, Octokit, Ink, React, Commander, Execa, Zod or terminal libraries.
- `application` — task-oriented use cases and workflow decisions.
- `ports` — interfaces for external boundaries.
- `infrastructure` — filesystem, locking, transactions, Git, GitHub, credentials and process adapters.
- `cli` — Commander commands plus interactive Ink, plain and JSON presentation.
- `bootstrap` — composition root that wires concrete adapters.

Keep dependencies moving toward the domain/application contracts. Infrastructure errors must become recovery-oriented `KestrelError` values before presentation. CLI and rendering code must not make domain decisions.

## Non-Negotiable Invariants

- Clone upstream repositories only. Never fork, push, open a pull request, install target-repository dependencies, or run target-repository builds/tests as part of Kestrel’s workflow.
- Store Kestrel metadata in the sidecar next to the clone, not inside the cloned repository.
- Preserve schema-versioned state, atomic writes, lock ownership, transaction intents, idempotent journal recovery and at-most-once journey events.
- Preserve resumable mission checkpoints and the documented `Mission` lifecycle; do not skip or invent durable state transitions.
- Fail closed on unsafe paths, conflicting recovery sources, malformed state and uncertain lock ownership.
- Propagate `SIGINT`/`SIGTERM` cancellation through external calls and process execution; do not leave partial state or duplicate durable events.
- Preserve immutable recommendation/agent handoff evidence and the machine-readable `--json` and `--no-interactive` output contracts.

## Development Workflow

1. Read the nearest existing implementation, test and documentation pattern before editing. Prefer an existing pattern over a second convention.
2. Identify the observable contract and its callers before changing an exported symbol. Use LSP for definitions, references, implementations, renames and code actions whenever the language server supports the target.
3. Keep changes narrow and boring. Do not add speculative abstractions, compatibility aliases, telemetry or retries outside the requested contract.
4. Keep domain/application logic independent of terminal presentation. Put filesystem, network, process and credential effects behind ports and infrastructure adapters.
5. For independent read-only investigations, parallelize. Serialize edits to the same file or interface. Agents must not dispatch their own agents.
6. Preserve or add focused behavioral tests before broad validation. Claims of completion require observed command or test evidence.

## Test-Flow Matrix

Choose the smallest test flow that proves the changed behavior, then run the applicable integration checks:

| Change                            | Required evidence                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Domain or application use case    | Focused unit/use-case tests for invariants, transitions, errors and cancellation.                      |
| Port or infrastructure adapter    | Adapter tests plus failure, cancellation, persistence, locking or recovery boundaries.                 |
| CLI or presentation               | Renderer/component tests plus built-CLI smoke coverage; preserve plain and JSON contracts.             |
| State, lock or transaction        | Recovery-projector tests and real-process E2E scenarios, including interruption/resume when relevant.  |
| Packaging or portability          | Build/package tests and portability coverage.                                                          |
| Persistent session or terminal UI | Component/state-transition tests, interactive CLI smoke coverage, and parity with plain/JSON behavior. |

Existing quality commands are `npm run boundaries`, `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm test`, `npm run build`, and `npm run check:runtime`. Use `npm run build` when build or packaging output is affected; use `npm run check:runtime` when runtime prerequisites are relevant.

## Terminal Session and UI Direction

The current CLI supports one-shot commands and has Ink components, but it does not yet implement one persistent terminal-session shell. Future work must preserve that distinction:

- Reconstruct session state from durable mission/application state, not only React/Ink memory.
- Keep themes, colors, terminal dimensions and key bindings in presentation adapters.
- Share application results through view models across interactive, plain and JSON renderers.
- Show real mission checkpoints for long-running progress; never fabricate progress.
- Treat interruption, restart and session exit as part of the existing lock/transaction recovery contract.
- Test UI behavior at component and state-transition level, then connect it to real CLI smoke/E2E behavior.

Do not introduce a session persistence schema or claim a UI feature exists until its end-to-end behavior and recovery semantics are implemented and verified.

## Agent and Model Routing

Use the least powerful agent that can handle the task:

- `scout` for fast, read-only repository discovery and pattern searches.
- `reviewer` for architecture, code-quality and contract review.
- `security-reviewer` for security, path containment, credentials and recovery analysis.
- `sonic` for strictly mechanical, isolated edits; escalate if the task needs judgment.
- `task` for focused multi-file implementation and integration work.
- `designer` only for genuinely visual terminal UI questions or mockups.

Reserve stronger models for architecture, security, recovery and final-branch review. Use lower-cost agents for complete, mechanical briefs. Reviewers receive the exact diff and acceptance criteria; they do not replace targeted tests.

## Token-Efficiency Rules

- Read only the relevant file ranges and one neighboring pattern before editing; avoid repository-wide scans when a symbol or directory is known.
- Use LSP instead of manual cross-file symbol searching for references and renames.
- Parallelize independent read-only work, but never parallelize competing edits.
- Pass large briefs and reports through files, not repeated prompt text. Keep each agent focused on one deliverable.
- Do not run formatters, linters or the full suite inside parallel implementation slices. Validate once at the integration boundary, plus focused tests for the changed contract.
- Reuse observed command output; do not rerun checks merely to restate the same evidence.

## Definition of Done

A change is done only when:

- The requested observable behavior is implemented end to end, with all affected callers and tests updated.
- Architecture, security, recovery, cancellation and output contracts remain intact.
- Targeted behavioral tests and applicable repository quality checks pass.
- Documentation and commands describe behavior that actually exists; no TODO, TBD, placeholder or unsupported fallback remains.
- Completion claims cite observed commands/tests and state any residual platform or security risk explicitly.
- The final diff contains no unrelated changes, generated artifacts or secrets.
