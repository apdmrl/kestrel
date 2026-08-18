# Kestrel v0.1 Implementation Progress

> This file tracks the **final-review remediation** pass described in
> `docs/kestrel/prompts/deepseek-kestrel-final-review-fixes.md`, which ran on top of the
> earlier post-review fix pass. Every required CLI-level E2E scenario and the full Node 24
> gate are green; known limitations are listed explicitly below.

Current phase: final review remediation — complete
Current verification: green — `npm ci`, boundaries, lint, format:check, typecheck,
test (**491 tests across 74 files**), build, `npm pack --dry-run`, `npm audit`
(0 vulnerabilities) and `npm audit --omit=dev` (0 vulnerabilities) all pass under
Node v24.19.0 / npm 11.17.0.
Last green code commit: 4230246 (test: prove complete CLI recovery contract)

## Final-review remediation tasks

- [x] Task 1 — Recover abandoned, ownerless, or malformed lock-guard reservations safely
      (atomic reservation + rename commit, token-named immutable owner records)
- [x] Task 2 — Require immutable recommendation identity for `mission accept --id`
      (per-ID snapshots under `$HOME/recommendations`, idempotent save, conflict rejection)
- [x] Task 3 — Preserve the JSON stdout contract during device authorization
      (auth guidance routed to stderr; device flow honors `GITHUB_API_URL`)
- [x] Task 4 — Model post-rename durability uncertainty correctly
      (read-back reconciliation after committed rename + directory-fsync failure)
- [x] Task 5 — Make workspace containment honest and enforceable
      (constrained threat model; no portable mkdirat; canonical verification; no cleanup
      through replaced parents; residual concurrent-local-attacker limitation documented)
- [x] Task 6 — Complete CLI-level E2E recovery contract
      (22 workflow scenarios + cross-process index serialization, three consecutive green runs)
- [x] Task 7 — Runtime reproducibility (`.nvmrc`, `check:runtime`), clean Ink test output,
      full Node 24 gate, and this truthful report

## Verification

- Node v24.19.0, npm 11.17.0 (see `.nvmrc`; `npm run check:runtime` fails clearly below Node 24)
- `npm ci`: clean install, 0 vulnerabilities
- `npm run boundaries`: pass
- `npm run lint`: pass
- `npm run format:check`: pass
- `npm run typecheck`: pass
- `npm test`: 491 passed (74 files), including 27 CLI/E2E tests
  (22 `test/e2e/workflows.test.ts` scenarios, 1 cross-process index test,
  4 built-CLI hierarchy tests)
- `npm run build`: pass
- `npm pack --dry-run`: pass (408 files; run with a writable npm cache in this environment)
- `npm audit`: 0 vulnerabilities; `npm audit --omit=dev`: 0 vulnerabilities
- CLI smoke checks (`node dist/cli/main.js`): `--help`, `mission --help`, `agent --help`,
  `verify --help`, `mission accept --help` all exit 0 with the complete hierarchy
- E2E suites run three consecutive times without flakiness

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
- Process-level cancellation (SIGINT/SIGTERM/SIGKILL) leaves no classified error by itself:
  the CLI registers no signal handler. Cancellation tests assert preserved resumable state,
  no partial mutation, and at-most-once side effects; a crashed process's stale lock must be
  cleared before a new process resumes (there is no CLI break-stale-lock command).

## Blockers

- None.
