# Kestrel AGENTS Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a concise root `AGENTS.md` that preserves Kestrel’s architecture and safety invariants while guiding future terminal-session work, testing, agent routing and token-efficient development.

**Architecture:** Add one repository-root guidance file; do not add nested agent files or modify product code. The document references existing layers, commands, tests and recovery contracts without introducing a new runtime abstraction.

**Tech Stack:** Markdown, Node 24, TypeScript, npm, Vitest, ESLint, Prettier, Ink, Commander.

**Spec:** `docs/superpowers/specs/2026-08-25-kestrel-agents-workflow-design.md`

## Global Constraints

- Preserve the dependency direction: the domain remains independent of infrastructure and presentation; application depends on domain and ports; infrastructure implements ports; CLI depends on application-facing contracts; bootstrap wires concrete adapters.
- Keep CLI presentation and terminal themes out of domain/application logic.
- Preserve clone-only behavior, sidecar metadata, atomic persistence, lock/transaction recovery and cancellation semantics.
- Do not claim terminal-session persistence or UI behavior that does not exist yet.
- Use existing npm scripts and repository test conventions; do not invent commands.
- Keep the file concise and actionable; do not duplicate full architecture/security documentation.

---

### Task 1: Create and verify the root agent contract

**Files:**

- Create: `AGENTS.md`
- Read: `README.md`, `docs/architecture.md`, `docs/security.md`, `docs/state-and-recovery.md`, `package.json`, `IMPLEMENTATION_PROGRESS.md`
- Verify: `AGENTS.md` formatting and referenced commands

**Interfaces:**

- Consumes: existing repository architecture, safety boundaries, test commands and approved design spec.
- Produces: a root-level `AGENTS.md` with nine sections: project intent; repository map; invariants; development workflow; test-flow matrix; terminal-session direction; agent/model routing; token efficiency; definition of done.

- [x] **Step 1: Write the document structure**

  Create `AGENTS.md` with these headings:

  ```markdown
  # Kestrel Agent Guide

  ## Project Intent

  ## Repository Map and Boundaries

  ## Non-Negotiable Invariants

  ## Development Workflow

  ## Test-Flow Matrix

  ## Terminal Session and UI Direction

  ## Agent and Model Routing

  ## Token-Efficiency Rules

  ## Definition of Done
  ```

- [x] **Step 2: Encode the repository boundaries**

  State that `domain` is pure and cannot import Node, Octokit, Ink, React, Commander, Execa, Zod or terminal libraries; `application` owns use cases; `ports` define external interfaces; `infrastructure` owns adapters; `cli` owns Commander and renderers; `bootstrap` wires concrete dependencies.

- [x] **Step 3: Encode safety and recovery invariants**

  State that Kestrel clones upstream repositories only, keeps metadata in sidecars, never pushes/forks/opens pull requests or installs/runs target-repository dependencies, and preserves schema-versioned atomic state, locks, transaction intents, idempotent recovery, fail-closed unsafe-path handling, evidence integrity and SIGINT/SIGTERM cancellation behavior.

- [x] **Step 4: Encode development and LSP workflow**

  Require reading the nearest existing pattern before editing, using LSP for definitions/references/implementations/renames/code actions when available, migrating callers for exported API changes, avoiding speculative abstractions, and keeping edits focused. State that independent read-only investigations may be parallelized but same-file edits must be serialized.

- [x] **Step 5: Encode the test-flow matrix and commands**

  Map domain/application, ports/infrastructure, CLI/presentation, state/recovery, packaging/portability and session/UI changes to their focused tests. Reference only existing commands: `npm run boundaries`, `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm test`, `npm run build`, and `npm run check:runtime` where applicable.

- [x] **Step 6: Encode future session/UI direction**

  State that one-shot output and persistent interactive sessions are distinct; session state must be reconstructable from durable application/mission state; themes, colors, terminal dimensions and key bindings belong in presentation; interactive/plain/JSON renderers share application view models; progress reflects real checkpoints; interruption and restart preserve recovery semantics; UI changes require component/state-transition tests plus CLI smoke/E2E coverage.

- [x] **Step 7: Encode agent/model routing and token efficiency**

  Recommend `scout` for read-only discovery, `reviewer` for architecture/code quality, `security-reviewer` for security/recovery, `sonic` for mechanical edits, `task` for multi-file implementation, and `designer` for genuinely visual UI questions. Reserve stronger models for high-risk reasoning; use lower-cost agents for narrow mechanical work; avoid duplicate file scans and defer formatter/linter/full-suite runs until integration validation.

- [x] **Step 8: Add definition-of-done rules**

  Require observable behavioral evidence, targeted tests, applicable quality checks, explicit residual risks and no unsupported completion claims. Require machine-readable output contracts and non-interactive behavior to remain stable.

- [x] **Step 9: Self-review the finished document**

  Read `AGENTS.md` from top to bottom. Check that every claim is supported by the repository or approved spec, that no product feature is presented as implemented, that all nine sections exist, and that no `TODO`, `TBD`, placeholder or invented command remains.

- [x] **Step 10: Run targeted verification**

  Run:

  ```bash
  npm run format:check
  npm run check:runtime
  npm run boundaries
  npm run lint
  npm run typecheck
  npm test
  ```

  Observed: Prettier reported all files formatted; runtime reported Node.js 24.19.0; boundaries, lint and typecheck exited 0; Vitest reported 77 files and 597 tests passed.

- [x] **Step 11: Commit the completed guide**

  Observed commits:

  ```text
  06c49ba docs: define Kestrel agent workflow
  fe6c08b docs: add Kestrel agent guide
  fd536fa docs: finalize agent workflow guidance
  ```
