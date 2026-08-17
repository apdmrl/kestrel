# Kestrel v0.1 Implementation Progress

Current milestone: 18 (complete)
Current task: 18.3 (complete)
Last green commit: pending final commit
Last verification: final gate — boundaries, lint, format, typecheck, test (356), build, pack all green

## Decisions

- 2026-08-17: Implementation started from the approved architecture and implementation plan.
- 2026-08-17: `EvidenceDecision` (`src/domain/policy/evidence-decision.ts`) was created in Task 4.2 because `Mission.complete(evidenceDecision)` needs it before Task 5.1; Task 5.1 layers the policy contract on top.
- 2026-08-17: `Mission.abandon()` is allowed from any non-terminal active state (ACCEPTED, PREPARING, IN_PROGRESS) per Task 12.3's "nonterminal active states", reconciling the Global Constraint diagram (IN_PROGRESS → ABANDONED) with the recoverable-preparation "Abandon" recovery action.
- 2026-08-17: `TransactionIntent` additionally stores `sidecarPath` (in Task 7.3) because recovery must locate the mission state file independently of the mission aggregate.
- 2026-08-17: The CLI entry point (`src/cli/main.ts`) is an allowed composition seam that imports bootstrap; the boundary scanner exempts it explicitly.
- 2026-08-17: The npm cache is configured at a writable workspace path via `npm_config_cache` in tests/packaging because the default `~/.npm` cache is read-only in this environment.
- 2026-08-17: `vitest` runs test files sequentially (`fileParallelism: false`) so the e2e build and package-pack tests do not race on `dist/`.

## Blockers

- None.
