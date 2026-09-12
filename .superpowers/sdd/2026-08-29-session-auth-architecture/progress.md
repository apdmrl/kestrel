# SDD ledger — plan: docs/superpowers/plans/2026-08-29-session-auth-architecture.md

Baseline: user-reported 88 test files / 773 tests passing; boundaries, lint, format:check, typecheck, and build passing before this plan. Per repository instruction, do not rerun that already-reported baseline solely to reconfirm it.
Workspace: current checkout on `main`, explicitly requested by the user; preserve all pre-existing uncommitted changes.

## Preflight task/interface scan

| Scope       | Producer / consumer                                                                                 | Finding / ruling                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task 1      | Produces `requireValidatedGitHubCredential`; Bootstrap `discover` consumes it                       | Consistent. Guard cannot call device-flow methods.                                                                                                                                                                                                                                                                                                                                                                                                            |
| Task 2      | Produces `CommandContext` and two-argument handlers; Bootstrap, Commander, and Session consume them | Consistent. Every LSP-reported caller must migrate in one cutover.                                                                                                                                                                                                                                                                                                                                                                                            |
| Task 3      | Produces reducer state/events; Tasks 4–5 consume auth, focus, transcript, and operation state       | Consistent. Async events require attempt/operation IDs.                                                                                                                                                                                                                                                                                                                                                                                                       |
| Task 4      | Produces navigation and interactive renderer; Task 5 consumes them                                  | Conflict: Task 4 changes controller results to ViewModels, but the plan omits `session.tsx` from Task 4. Ruling: Task 4 also owns the smallest `session.tsx`/`session.test.tsx` adaptation needed to render controller ViewModels so its commit compiles; Task 5 replaces that adaptation with reducer/runtime integration. Cost if wrong: small duplicated integration churn, but no broken intermediate commit.                                             |
| Task 5      | Produces startup deadline/child cancellation; Task 6 consumes observable behavior                   | Consistent. Deadline settles runtime even when a fake handler ignores abort; adapter resources still receive abort.                                                                                                                                                                                                                                                                                                                                           |
| Task 6      | Produces integration evidence; Task 7 consumes verified behavior for docs                           | Conflict: piped stdin is not guaranteed to support Ink raw-mode input. Ruling: automated tests may use pipes for startup output and process termination only; input-level local-command/login-cancel behavior stays in FakeInk component tests, and Task 7's real-PTY smoke proves the built interactive input path. Cost if wrong: the permanent suite has less built-process key-input coverage, offset by component tests plus required real-PTY evidence. |
| Task 7      | Produces docs and full integration gate                                                             | Consistent. Documentation follows observed behavior only.                                                                                                                                                                                                                                                                                                                                                                                                     |
| Tasks 1 ↔ 2 | Both modify Bootstrap and tests                                                                     | Task 1 uses the current captured signal; Task 2 removes it repository-wide. Ordered and consistent.                                                                                                                                                                                                                                                                                                                                                           |
| Tasks 1 ↔ 6 | Both modify built/auth integration tests                                                            | Task 1 establishes no implicit Find login; Task 6 broadens provider-request evidence. Ordered and consistent.                                                                                                                                                                                                                                                                                                                                                 |
| Tasks 2 ↔ 4 | Both modify session controller/tests                                                                | Task 2 changes invocation context; Task 4 changes output representation. Ordered and distinct.                                                                                                                                                                                                                                                                                                                                                                |
| Tasks 2 ↔ 5 | Both modify Session/main                                                                            | Ruling: Task 2 removes `main`'s destructive `onCancel` callback but may leave `SessionProps.onCancel` temporarily unused; Task 5 removes the prop and implements child cancellation. Cost if wrong: one intermediate commit has no busy-key cancellation through main, but focused Task 2 contracts remain valid and Task 5 restores the final behavior.                                                                                                      |
| Tasks 3 ↔ 4 | Navigation consumes auth state                                                                      | Exact `SessionAuthState` names from Task 3 are binding for Task 4.                                                                                                                                                                                                                                                                                                                                                                                            |
| Tasks 3 ↔ 5 | Runtime dispatches reducer events                                                                   | Exact event names/IDs from Task 3 are binding for Task 5.                                                                                                                                                                                                                                                                                                                                                                                                     |
| Tasks 4 ↔ 5 | Both modify Session/dashboard interaction                                                           | Task 4 owns category/action rendering; Task 5 owns reducer/runtime wiring and key lifecycle.                                                                                                                                                                                                                                                                                                                                                                  |
| Tasks 4 ↔ 6 | Both touch session auth tests                                                                       | Task 4 proves renderer spelling; Task 6 adds regression/integration evidence.                                                                                                                                                                                                                                                                                                                                                                                 |
| Tasks 5 ↔ 6 | Runtime behavior is the integration target                                                          | Consistent. No test may rely on automatic login.                                                                                                                                                                                                                                                                                                                                                                                                              |

## Execution rulings

Ruling: Work in the current checkout rather than create an isolated worktree — the user explicitly required continuing the existing uncommitted worktree — cost if wrong: implementation and prior user edits share files, so every worker must preserve unrelated hunks and stage task-owned changes only.

Ruling: The available subagent API exposes agent roles but no `gpt-5.6 terra` or effort-level selector — use the general implementation agent and explicit task briefs/reviews — cost if wrong: exact requested model/effort routing cannot be guaranteed by this harness.

Task 1: implementer attempt 1 cancelled — agent stalled before edits/report; no new task files or commit were produced.

Task 1: implementer attempt 2 cancelled — second general agent stalled during pattern reading; no new task files, report, or commit were produced.
Ruling: Retry Task 1 with the mechanical `sonic` agent because the brief fixes the interface, tests, and affected symbols exactly — cost if wrong: a low-reasoning worker may need a focused correction round, which the mandatory reviewer gate will catch.

Task 1: sonic attempt failed before execution — configured provider returned HTTP 404; no files changed.

Ruling: The current request explicitly requires `task` agents after the implementation plan, superseding the earlier sonic retry ruling — use a fresh task implementer for every implementation or correction dispatch — cost if wrong: mechanical tasks use a more capable worker than necessary, but preserve the user's required routing.

Ruling: Adopt the designer audit amendments in the existing approved plan rather than introduce a second UI design — enforce the 80x24/narrow budget, color-independent focus/availability, and exact displayed recommendation-to-accept path — cost if wrong: Tasks 3–6 are broader than the original presentation acceptance matrix, but retain the same architecture and persistence contracts.

Task 1: task-agent attempt 3 failed before execution — provider returned `server_error: Insufficient balance`; no files, report, or commit were produced.

Task 1: task-agent attempt 4 cancelled after repeated bounded waits with no response; no report or commit was produced.

Task 1: fix round 1/5 (1 addressed, 0 open — removed out-of-scope default-client-id hunks from the net task diff while preserving them unstaged; commits d9562c9..8afbc62)

Task 1: complete (commits 9c3e3c5..8afbc62, review clean)

Task 2: fix round 1/5 (3 addressed, 1 report wording open — removed ignored BootstrapOptions signal, deleted generated reject artifacts, restored unrelated main entrypoint hunk; commits f7befe5..29f8be1)

Task 2: fix round 2/5 (1 addressed, 0 open — report now consistently records the prohibited reset as a process deviation; no source commit)

Task 2: complete (commits 8afbc62..29f8be1, review clean)

Task 3: fix round 1/5 (5 addressed, 0 open — hardened login success, restoration, auth-result typing, and coverage; commits 3b434f4..380a8b4)

Task 3: complete (commits 29f8be1..380a8b4, review clean)

Task 4: fix rounds 1–5 plus scoped corrections (all review findings addressed — live DashboardShell navigation, reducer-owned auth state, exact recommendation action, real stdout capabilities, bounded display-cell row budgeting, production pane/action geometry, dependency lock, and logout recovery; commits 41570fa..c1b6667)

Task 4: two correction agents were cancelled after leaving incomplete or malformed uncommitted dashboard work; the owned file was recovered from the accepted HEAD baseline, valid partial tests were retained, and focused verification finished at 8 files / 248 tests.

Task 4: complete (commits 380a8b4..c1b6667, final scoped review clean)

Task 5: fix round 1/5 (2 addressed — startup runtime disposal on unmount and identity-scoped busy cleanup; commits 52f2e40..caac3d2)

Task 5 process deviation: the round-1 implementer created `stash@{0}` despite the no-stash ruling. It contained only stale dashboard edits; the accepted HEAD side was restored, the resolved file was verified with no staged diff, and the temporary stash was dropped.

Task 5: fix round 2/5 (1 Important and 2 Minor addressed — prompt clear, synchronous admission slot, direct timer/listener cleanup proof; commit 96d5435)

Task 5: fix round 3/5 (1 Important and 3 Minor addressed — exact-once transcript append, post-release prompt proof, true pasted remainder, all parent listeners matched; commits 7426da5..64aa6c2)

Task 5: complete (commits c1b6667..64aa6c2, scoped review PASS; focused Task 5 evidence 108 tests plus adjacent Task 4 evidence 129 tests)

Task 6: two implementation agents stopped with incomplete uncommitted E2E work; one temporarily suppressed build errors. The suppression was removed, the ordinary build was restored, and valid partial fixture tests were retained.

Task 6: fix round 1/5 (4 review findings addressed — credential-fill cancellation, mandatory builds, causal no-store proof, persisted approval fixture; commits e98554f..1d27165)

Task 6: fix round 2/5 (5 review findings addressed — helper-detection/logout signal propagation, required port signal, built-suite build gate, real authenticateGitHub store boundary, exact approval record; commit b3df46d)

Task 6: complete (commits 36d9d9b..b3df46d, final scoped review PASS; ordinary build passed and focused evidence 6 files / 88 tests)

Task 7 PTY smoke: built CLI rendered immediately; Auth action first Return filled `/auth login`, second Return displayed the local fixture URI/code; Ctrl+C closed the held token poll without exiting; the same session rendered `/progress`; `/exit` exited 0. No browser completion or credential storage.

Task 7: fix round 1/5 (3 documentation findings addressed — offline category scope, in-flight-only transient authorization wording, repository gate accurately pending; commit e5c359b)

Task 7 documentation complete (commits b3df46d..e5c359b, scoped docs review PASS; focused docs/session/auth evidence 3 files / 24 tests). Repository-wide gate remains pending final verification.
