# Interactive Session Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an immediately rendered, auth-aware interactive session in which GitHub login is explicit, GitHub-dependent commands fail closed, local commands remain available offline, and foreground login cancellation keeps the session alive.

**Architecture:** The application layer validates credentials and guards GitHub-dependent operations without starting device flow. The CLI passes a per-invocation `CommandContext`, while a pure interactive reducer and runtime own transient auth, navigation, deadline, and child-cancellation state. Plain and JSON renderers remain stable; the interactive session gets its own recovery renderer.

**Tech Stack:** TypeScript 5.6, Node.js 24+, React 18, Ink 5, Commander 12, Vitest 3, Octokit device OAuth, Execa

**Spec:** `docs/superpowers/specs/2026-08-29-session-auth-architecture-design.md`

## Global Constraints

- Preserve all pre-existing uncommitted work. Never reset, checkout, stash, or overwrite user changes.
- Before modifying any exported symbol, use TypeScript LSP references and migrate every caller in the same task.
- `domain` remains free of Node, React, Ink, Commander, Octokit, Execa, Zod, and terminal dependencies.
- Startup renders before auth validation completes and uses an exact 5,000 ms interactive deadline.
- Startup, `find`, `--json`, and `--no-interactive` never begin device flow implicitly.
- Only explicit `auth login` or `/auth login` may begin device flow.
- Missing, expired, or unverifiable auth disables GitHub-dependent work; local mission, journey, progress, and preferences remain available.
- No durable session/device-flow state or persistence schema is introduced.
- JSON stays `schemaVersion: 1` with the existing envelope and view-model fields.
- Plain output remains ANSI-free and uses shell commands; interactive recovery uses slash commands.
- Every operation propagates its own `AbortSignal` through application, ports, credential helpers, processes, browser launch, and GitHub requests.
- First Ctrl+C while a session command is active aborts only that command; process SIGINT/SIGTERM still aborts the session lifetime.
- Stage only task-owned hunks. Existing modified files require `git add -p`; inspect `git diff --cached` before each commit.
- Do not install target-repository dependencies or run target-repository builds/tests.

## File Structure

### New files

- `src/application/auth/require-validated-github-credential.ts` — read and live-validate one credential without device flow.
- `src/application/auth/require-validated-github-credential.test.ts` — missing, valid, expired, network, cancellation, and no-device-flow contracts.
- `src/cli/interactive/session-state.ts` — pure session/auth/operation reducer and initial state.
- `src/cli/interactive/session-state.test.ts` — transition tables, stale result rejection, and login restoration.
- `src/cli/interactive/session-navigation.ts` — category/action definitions and auth-derived availability.
- `src/cli/interactive/session-navigation.test.ts` — contextual action and recovery availability contracts.
- `src/cli/interactive/session-renderer.ts` — interactive-only rendering and slash-command recovery.
- `src/cli/interactive/session-renderer.test.ts` — interactive auth status/error/device notice rendering.
- `src/cli/interactive/session-runtime.ts` — startup deadline and parent/child abort utilities.
- `src/cli/interactive/session-runtime.test.ts` — fake-timer startup and cancellation lifecycle tests.

### Existing files changed

- `src/cli/command-handlers.ts` — exported `CommandContext` and second context parameter on every handler.
- `src/bootstrap/index.ts` — validated credential guard, per-invocation signal use, and explicit-only login.
- `src/bootstrap/index.test.ts` — Find gating, signal propagation, and explicit device-flow assertions.
- `src/cli/create-program.ts` / `.test.ts` — pass process operation context while preserving plain/JSON behavior.
- `src/cli/interactive/session-controller.ts` / `.test.ts` — pass operation context and return view/error models for interactive rendering.
- `src/cli/interactive/session.tsx` / `.test.tsx` — reducer/runtime integration and focused operation cancellation.
- `src/cli/interactive/session-auth.test.tsx` — startup and real input-level auth behavior.
- `src/cli/interactive/dashboard.tsx` / `.test.tsx` — category sidebar and contextual action panel.
- `src/cli/main.ts` and `src/bootstrap/index.test.ts` — separate process lifetime from handler operation signals.
- `test/cli-built.test.ts`, `test/e2e/auth-cli.test.ts`, `test/e2e/workflows.test.ts` — built CLI, offline, cancellation, and contract regressions.
- `README.md`, `docs/troubleshooting.md` — verified behavior only.

---

### Task 1: Guard GitHub Operations Without Device Flow

**Files:**

- Create: `src/application/auth/require-validated-github-credential.ts`
- Create: `src/application/auth/require-validated-github-credential.test.ts`
- Modify: `src/bootstrap/index.ts` (`requireGithubToken`, `discover`)
- Modify: `src/bootstrap/index.test.ts` (Find auth tests)
- Modify: `test/cli-built.test.ts` (unauthenticated Find expectation)

**Interfaces:**

- Consumes: `CredentialStore.get(service, account, signal?)`, `GitHubGateway.getViewer(token, signal?)`, existing `KestrelError` codes.
- Produces: `requireValidatedGitHubCredential(deps, input): Promise<ValidatedGitHubCredential>` where the result is `{ readonly token: string; readonly login: string }` and the function can never begin device flow.

- [ ] **Step 1: Write guard tests that fail before implementation**

```ts
it("fails closed without beginning device flow when no credential exists", async () => {
  const gateway = new FakeGateway();
  await expect(
    requireValidatedGitHubCredential(
      { credentialStore: new FakeCredentialStore(), gateway },
      { account: "github" },
    ),
  ).rejects.toMatchObject({ code: "DM_GITHUB_AUTH_REQUIRED" });
  expect(gateway.viewerCalls).toBe(0);
  expect(gateway.deviceFlowCalls).toBe(0);
});

it("returns the live identity and token after validation", async () => {
  const store = new FakeCredentialStore({
    service: "github",
    account: "octocat",
    token: "cached-token",
  });
  const result = await requireValidatedGitHubCredential(
    { credentialStore: store, gateway: new FakeGateway({ login: "octocat" }) },
    { account: "github" },
  );
  expect(result).toEqual({ token: "cached-token", login: "octocat" });
});
```

Add focused cases proving `DM_GITHUB_AUTH_EXPIRED` is propagated, network errors are not demoted, and the same input signal reaches both credential store and viewer validation.

- [ ] **Step 2: Run the focused guard test and observe failure**

Run: `npx vitest run src/application/auth/require-validated-github-credential.test.ts`

Expected: FAIL because the module/function does not exist.

- [ ] **Step 3: Implement the non-interactive guard**

```ts
export interface ValidatedGitHubCredential {
  readonly token: string;
  readonly login: string;
}

export async function requireValidatedGitHubCredential(
  deps: { readonly credentialStore: CredentialStore; readonly gateway: GitHubGateway },
  input: { readonly account: string; readonly signal?: AbortSignal },
): Promise<ValidatedGitHubCredential> {
  const credential = await deps.credentialStore.get("github", input.account, input.signal);
  if (credential === undefined) throw githubAuthRequiredError();
  const viewer = await deps.gateway.getViewer(credential.token, input.signal);
  return { token: credential.token, login: viewer.login };
}
```

`githubAuthRequiredError()` uses code `DM_GITHUB_AUTH_REQUIRED`, category `USER_ACTION_REQUIRED`, recovery strategy `REAUTHENTICATE`, no retry, and generic application wording. Do not import or call `authenticateGitHub`.

- [ ] **Step 4: Replace Bootstrap's implicit authentication path**

Delete `requireGithubToken`. In `discover`, call the new guard before creating `GithubChallengeSource`:

```ts
const auth = await requireValidatedGitHubCredential(
  { credentialStore, gateway },
  { account: "github", ...(context.signal === undefined ? {} : { signal: context.signal }) },
);
const source = options.challengeSourceFactory?.(auth.token) ?? createGithubSource(auth.token);
```

Use the current bootstrap operation signal when calling the guard in this task. Task 2 replaces every bootstrap-captured handler signal with invocation context in one repository-wide cutover. Add bootstrap tests asserting missing auth rejects with `DM_GITHUB_AUTH_REQUIRED`, `challengeSourceFactory` is not called, and `gateway.deviceFlowCalls` stays zero even when bootstrap is interactive.

- [ ] **Step 5: Update the built CLI expectation**

Change the unauthenticated Find smoke test so interactive mode is safe and deterministic:

```ts
const result = await runCli(["find"], credentiallessEnv);
expect(result.code).not.toBe(0);
expect(result.stderr).toContain("DM_GITHUB_AUTH_REQUIRED");
expect(result.stderr).not.toContain("login/device");
```

Do not require `--no-interactive` to suppress an implicit flow; there is no implicit flow anymore.

- [ ] **Step 6: Run focused tests**

Run: `npx vitest run src/application/auth/require-validated-github-credential.test.ts src/bootstrap/index.test.ts test/cli-built.test.ts`

Expected: PASS; built CLI test performs its existing build hook.

- [ ] **Step 7: Commit task-owned hunks**

```bash
git add src/application/auth/require-validated-github-credential.ts src/application/auth/require-validated-github-credential.test.ts
git add -p src/bootstrap/index.ts src/bootstrap/index.test.ts test/cli-built.test.ts
git diff --cached
git commit -m "fix(auth): prevent implicit login for github operations"
```

### Task 2: Pass Operation-Scoped Command Context

**Files:**

- Modify: `src/cli/command-handlers.ts`
- Modify: `src/bootstrap/index.ts`
- Modify: `src/bootstrap/index.test.ts`
- Modify: `src/cli/create-program.ts`
- Modify: `src/cli/create-program.test.ts`
- Modify: `src/cli/interactive/session-controller.ts`
- Modify: `src/cli/interactive/session-controller.test.ts`
- Modify: `src/cli/interactive/session.test.tsx`
- Modify: `src/cli/interactive/session-auth.test.tsx`
- Modify: `src/cli/main.ts`
- Modify: `test/docs/commands.test.ts`

**Interfaces:**

- Consumes: existing command-specific argument objects and process lifetime signal from `main`.
- Produces: `CommandContext`; every `CommandHandlers` method has `(args, context)`, with `{}` as args for no-argument commands. `createProgram` accepts `signal?: AbortSignal` and passes it in context.

- [ ] **Step 1: Use LSP references and add failing context tests**

Run LSP references for `CommandHandlers` before editing. Add tests that capture the second parameter:

```ts
const signal = new AbortController().signal;
const authStatus = vi.fn().mockResolvedValue(authStatusView("CONNECTED"));
const program = createProgram({ handlers: handlers({ authStatus }), signal });
await program.parseAsync(["node", "kestrel", "auth", "status"]);
expect(authStatus).toHaveBeenCalledWith({}, { signal });
```

In bootstrap tests, call one handler with a unique signal and assert it reaches the relevant fake port rather than the old bootstrap option signal.

- [ ] **Step 2: Run focused tests and observe argument failures**

Run: `npx vitest run src/cli/create-program.test.ts src/bootstrap/index.test.ts src/cli/interactive/session-controller.test.ts`

Expected: FAIL because handlers do not yet accept or forward `CommandContext`.

- [ ] **Step 3: Change the exported handler contract in one cutover**

```ts
export interface CommandContext {
  readonly signal?: AbortSignal;
  readonly onNotice?: (view: ViewModel) => void;
}

type Handler<Args> = (args: Args, context: CommandContext) => Promise<ViewModel>;

export interface CommandHandlers {
  readonly find: Handler<{ readonly mood: string; readonly type?: string }>;
  readonly authLogin: Handler<Record<string, never>>;
  readonly authStatus: Handler<Record<string, never>>;
  readonly authLogout: Handler<{ readonly confirmation?: string }>;
  readonly missionAccept: Handler<{ readonly recommendationId: string }>;
  readonly missionPrepare: Handler<{ readonly missionId?: string }>;
  readonly missionResume: Handler<{ readonly missionId?: string }>;
  readonly missionCurrent: Handler<{ readonly missionId?: string }>;
  readonly missionComplete: Handler<{ readonly missionId?: string }>;
  readonly missionBreakLock: Handler<{ readonly missionId: string }>;
  readonly missionAbandon: Handler<{ readonly missionId?: string; readonly reason: string }>;
  readonly agentBrief: Handler<{ readonly missionId?: string; readonly hypothesis?: string }>;
  readonly verifySubmission: Handler<{ readonly missionId?: string; readonly prNumber: number }>;
  readonly verifyLink: Handler<{ readonly missionId?: string; readonly prNumber: number }>;
  readonly verifyMerge: Handler<{ readonly missionId?: string; readonly prNumber: number }>;
  readonly journey: Handler<Record<string, never>>;
  readonly progress: Handler<Record<string, never>>;
  readonly preferencesGet: Handler<Record<string, never>>;
  readonly preferencesSet: Handler<{ readonly language?: string; readonly mode?: string }>;
}
```

Keep all existing command-specific fields and optionality exactly as today.

- [ ] **Step 4: Move Bootstrap signal reads to invocation context**

Every returned handler becomes `(args, context) =>`. Replace all handler-path `options.signal` uses with `context.signal`, including auth, discovery, mission preparation, Git factories, verification, browser launch, and agent handoff. Remove `signal` from `BootstrapOptions` after LSP/reference checks prove no bootstrap-time operation needs it.

Explicit login uses context notices:

```ts
authLogin: async (_args, context) => {
  const auth = await authenticateGitHub(
    { credentialStore, gateway },
    {
      account: "github",
      interactive,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      onAuthorization: async (authorization) => {
        context.onNotice?.(deviceAuthorizationView(authorization));
        if (openBrowser) {
          await browserLauncher.open(authorization.verificationUri, context.signal);
        }
      },
    },
  );
  return {
    kind: "auth-status",
    connected: true,
    login: auth.account,
    detail: "CONNECTED",
  };
},
```

- [ ] **Step 5: Update one-shot and interactive callers**

Add `signal?: AbortSignal` to `ProgramOptions`; use one shared context factory per invocation:

```ts
const context = (): CommandContext =>
  options.signal === undefined ? {} : { signal: options.signal };

options.handlers.authStatus({}, context());
options.handlers.find(findArgs, context());
options.handlers.authLogin(
  {},
  {
    ...context(),
    onNotice: (view) => err(renderPlain(view) + "\n"),
  },
);
```

Change `createSessionController` to accept an explicit context when executing a parsed command:

```ts
type RunSessionCommand = (
  command: SessionCommand,
  context: CommandContext,
) => Promise<SessionControllerResult>;
```

Do not let the controller own an AbortController.

- [ ] **Step 6: Wire process lifetime only at process edges**

`main` stops passing `signal` into `bootstrap`. It passes `controller.signal` to `createProgram` for one-shot commands and to `Session` as the session parent signal. Remove the current `onCancel` callback that aborts/unmounts the entire app; Task 5 replaces it with child-operation cancellation.

- [ ] **Step 7: Update every fake handler and run type-focused tests**

Update all 27 LSP-reported references. Fakes may ignore the second parameter but must conform to the new signature. Run:

`npx vitest run src/cli/create-program.test.ts src/bootstrap/index.test.ts src/cli/interactive/session-controller.test.ts src/cli/interactive/session.test.tsx src/cli/interactive/session-auth.test.tsx test/docs/commands.test.ts`

Then run: `npm run typecheck`

Expected: all PASS and no old one-argument callsite remains.

- [ ] **Step 8: Commit task-owned hunks**

```bash
git add -p src/cli/command-handlers.ts src/bootstrap/index.ts src/bootstrap/index.test.ts src/cli/create-program.ts src/cli/create-program.test.ts src/cli/interactive/session-controller.ts src/cli/interactive/session-controller.test.ts src/cli/interactive/session.test.tsx src/cli/interactive/session-auth.test.tsx src/cli/main.ts test/docs/commands.test.ts
git diff --cached
git commit -m "refactor(cli): scope cancellation to command invocations"
```

### Task 3: Implement the Pure Session State Machine

**Files:**

- Create: `src/cli/interactive/session-state.ts`
- Create: `src/cli/interactive/session-state.test.ts`

**Interfaces:**

- Consumes: `TranscriptEntry` and stable auth status/error codes.
- Produces: `SessionState`, `SessionEvent`, `initialSessionState()`, and `sessionReducer(state, event)`; Task 5 depends on exact event names below.

- [ ] **Step 1: Write table-driven failing transition tests**

```ts
it.each([
  [{ type: "AUTH_RESOLVED", attemptId: 1, detail: "NOT_CONNECTED", login: null }, "required"],
  [{ type: "AUTH_RESOLVED", attemptId: 1, detail: "EXPIRED", login: null }, "expired"],
  [{ type: "AUTH_RESOLVED", attemptId: 1, detail: "CONNECTED", login: "octocat" }, "connected"],
  [{ type: "AUTH_FAILED", attemptId: 1, errorCode: "DM_NETWORK_UNAVAILABLE" }, "unknown"],
] as const)("reduces startup auth result %#", (event, expected) => {
  expect(sessionReducer(initialSessionState(), event).auth.status).toBe(expected);
});

it("ignores a late result from an expired auth attempt", () => {
  const retrying = sessionReducer(initialSessionState(), {
    type: "AUTH_CHECK_STARTED",
    attemptId: 2,
  });
  const late = sessionReducer(retrying, {
    type: "AUTH_RESOLVED",
    attemptId: 1,
    detail: "CONNECTED",
    login: "stale",
  });
  expect(late).toBe(retrying);
});
```

Also cover operation IDs, connected/logout, unknown/retry, login start, authorization notice, successful login, cancellation restoring each prior auth state, local completion preserving auth, prompt/transcript changes, category/action focus, Home clear, and bounded transcript length.

- [ ] **Step 2: Run the state test and observe module failure**

Run: `npx vitest run src/cli/interactive/session-state.test.ts`

Expected: FAIL because the reducer does not exist.

- [ ] **Step 3: Define the exact state and events**

```ts
export type SessionAuthState =
  | { readonly status: "checking"; readonly attemptId: number }
  | { readonly status: "connected"; readonly login: string }
  | { readonly status: "required" }
  | { readonly status: "expired" }
  | { readonly status: "unknown"; readonly errorCode: string }
  | {
      readonly status: "logging-in";
      readonly phase: "starting" | "awaiting-user";
      readonly authorization?: {
        readonly verificationUri: string;
        readonly userCode: string;
        readonly expiresAt: number;
      };
    };

export type OperationState =
  | { readonly status: "idle" }
  | {
      readonly status: "running";
      readonly operationId: number;
      readonly command: string;
      readonly cancellable: boolean;
      readonly authBeforeLogin?: SessionAuthState;
    };

export interface SessionState {
  readonly auth: SessionAuthState;
  readonly operation: OperationState;
  readonly input: string;
  readonly transcript: readonly TranscriptEntry[];
  readonly activeSectionId: string;
  readonly focus: "prompt" | "sidebar" | "actions";
  readonly selectedSectionIndex: number;
  readonly selectedActionIndex: number;
}
```

Events must include `AUTH_CHECK_STARTED`, `AUTH_RESOLVED`, `AUTH_FAILED`, `OPERATION_STARTED`, `LOGIN_AUTHORIZATION`, `OPERATION_SUCCEEDED`, `OPERATION_FAILED`, `OPERATION_CANCELLED`, `INPUT_CHANGED`, `TRANSCRIPT_APPENDED`, `TRANSCRIPT_CLEARED`, `SECTION_SELECTED`, `ACTION_SELECTED`, and `HOME_SELECTED` with attempt/operation IDs on asynchronous completions.

- [ ] **Step 4: Implement minimal pure reducer transitions**

Use exhaustive switches and return the original object for stale attempt/operation IDs. Store `authBeforeLogin` only in the running operation; restore it on login cancellation/failure. Never store device code or token. Preserve the existing 200-entry transcript bound.

- [ ] **Step 5: Run reducer tests**

Run: `npx vitest run src/cli/interactive/session-state.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the isolated state machine**

```bash
git add src/cli/interactive/session-state.ts src/cli/interactive/session-state.test.ts
git diff --cached
git commit -m "feat(tui): add deterministic session state machine"
```

### Task 4: Add Contextual Navigation and Interactive Recovery Rendering

**Files:**

- Create: `src/cli/interactive/session-navigation.ts`
- Create: `src/cli/interactive/session-navigation.test.ts`
- Create: `src/cli/interactive/session-renderer.ts`
- Create: `src/cli/interactive/session-renderer.test.ts`
- Modify: `src/cli/interactive/dashboard.tsx`
- Modify: `src/cli/interactive/dashboard.test.tsx`
- Modify: `src/cli/interactive/session-controller.ts`
- Modify: `src/cli/interactive/session-controller.test.ts`

**Interfaces:**

- Consumes: `SessionAuthState`, `ViewModel`, `ErrorViewModel`, and stable auth error codes.
- Produces: `NAVIGATION_SECTIONS`, `actionsForSection(sectionId, auth)`, `renderSessionView(view)`, and dashboard props for contextual actions.

- [ ] **Step 1: Write failing navigation policy tests**

```ts
it("disables Find and exposes login recovery when auth is required", () => {
  const actions = actionsForSection("find", { status: "required" });
  expect(actions).toEqual([
    expect.objectContaining({
      id: "find.run",
      availability: { status: "disabled", reason: expect.any(String) },
    }),
    expect.objectContaining({
      id: "auth.login",
      command: "/auth login",
      availability: { status: "enabled" },
    }),
  ]);
});

it("keeps local progress enabled while auth is unknown", () => {
  expect(
    actionsForSection("progress", { status: "unknown", errorCode: "DM_NETWORK_UNAVAILABLE" })[0],
  ).toMatchObject({ command: "/progress", availability: { status: "enabled" } });
});
```

Cover adaptive Auth actions for all six auth states and connected/required Find availability.

- [ ] **Step 2: Write failing interactive renderer tests**

```ts
expect(
  renderSessionView({
    kind: "auth-status",
    connected: false,
    login: null,
    detail: "NOT_CONNECTED",
  }),
).toMatchObject({ text: expect.stringContaining("/auth login"), recoveryCommand: "/auth login" });

expect(renderSessionView(errorViewModel(authRequiredError))).toMatchObject({
  text: expect.not.stringContaining("kestrel auth login"),
  recoveryCommand: "/auth login",
});
```

Assert device authorization includes URI/user code once and never includes device code/token. Assert `DM_GITHUB_AUTH_CANCELLED` returns neutral `output`, not `error`.

- [ ] **Step 3: Run the new tests and observe missing modules**

Run: `npx vitest run src/cli/interactive/session-navigation.test.ts src/cli/interactive/session-renderer.test.ts`

Expected: FAIL because both modules are absent.

- [ ] **Step 4: Implement category/action metadata**

Define `NavigationSection`, `SessionAction`, and `ActionAvailability` exactly as the spec. Use these action templates:

```ts
const SECTION_ACTIONS = {
  home: [],
  find: [{ id: "find.run", label: "Find a challenge", command: "/find" }],
  mission: [
    { id: "mission.current", label: "Current mission", command: "/mission current" },
    { id: "mission.accept", label: "Accept recommendation", command: "/mission accept --id " },
    { id: "mission.prepare", label: "Prepare mission", command: "/mission prepare" },
    { id: "mission.resume", label: "Resume preparation", command: "/mission resume" },
    { id: "mission.complete", label: "Complete mission", command: "/mission complete" },
    { id: "mission.abandon", label: "Abandon mission", command: "/mission abandon --reason " },
  ],
  agent: [{ id: "agent.brief", label: "Create handoff", command: "/agent brief" }],
  verify: [
    { id: "verify.submission", label: "Verify submission", command: "/verify submission --pr " },
    { id: "verify.link", label: "Verify issue link", command: "/verify link --pr " },
    { id: "verify.merge", label: "Verify merge", command: "/verify merge --pr " },
  ],
  progress: [{ id: "progress.show", label: "Show progress", command: "/progress" }],
  journey: [{ id: "journey.show", label: "Show journey", command: "/journey" }],
  auth: [],
  preferences: [
    { id: "preferences.get", label: "Show preferences", command: "/preferences get" },
    { id: "preferences.language", label: "Set language", command: "/preferences set --language " },
    { id: "preferences.mode", label: "Set mode", command: "/preferences set --mode " },
  ],
} as const;
```

Derive Auth actions from all six auth states. When Find is unavailable, return its disabled action followed by enabled `/auth login` recovery for required/expired, or `/auth status` recovery for checking/unknown. No fixed Auth command remains in the sidebar definition.

- [ ] **Step 5: Implement interactive rendering**

```ts
export interface SessionRenderedView {
  readonly kind: "output" | "error";
  readonly text: string;
  readonly recoveryCommand?: string;
}

export function renderSessionView(view: ViewModel): SessionRenderedView {
  if (view.kind === "error") return renderSessionError(view);
  if (view.kind === "auth-status") return renderSessionAuthStatus(view);
  if (view.kind === "device-authorization") {
    return { kind: "output", text: `Open ${view.verificationUri} and enter ${view.userCode}` };
  }
  return { kind: "output", text: renderPlain(view) };
}
```

Only the fallback uses `renderPlain`; auth/error/device paths must be interactive-specific. Map required/expired to `/auth login`, unknown/startup failure to `/auth status`, and cancellation to neutral output.

- [ ] **Step 6: Make the controller return view models, not pre-rendered plain strings**

Change controller result output/error variants to carry `ViewModel`. Interim notices also carry `ViewModel`. Rendering now happens at `Session` through `renderSessionView`; one-shot CLI remains unchanged.

- [ ] **Step 7: Render category and contextual action panels**

Replace command-bearing `NavigationItem` with category-only metadata. Add a compact `ContextActions` component showing action label, command, disabled reason, and active marker. After sidebar Enter, focus the first contextual action; ↑/↓ moves within actions; Enter on enabled action fills the prompt; Enter on disabled action leaves the command untouched and exposes its reason/recovery row. Keep the initial dashboard at or below 40 lines.

- [ ] **Step 8: Run focused rendering tests**

Run: `npx vitest run src/cli/interactive/session-navigation.test.ts src/cli/interactive/session-renderer.test.ts src/cli/interactive/dashboard.test.tsx src/cli/interactive/session-controller.test.ts`

Expected: PASS; no interactive assertion contains `kestrel auth login`.

- [ ] **Step 9: Commit presentation changes**

```bash
git add src/cli/interactive/session-navigation.ts src/cli/interactive/session-navigation.test.ts src/cli/interactive/session-renderer.ts src/cli/interactive/session-renderer.test.ts
git add -p src/cli/interactive/dashboard.tsx src/cli/interactive/dashboard.test.tsx src/cli/interactive/session-controller.ts src/cli/interactive/session-controller.test.ts
git diff --cached
git commit -m "feat(tui): add contextual auth-aware navigation"
```

### Task 5: Integrate Startup Auth Deadline and Foreground Cancellation

**Files:**

- Create: `src/cli/interactive/session-runtime.ts`
- Create: `src/cli/interactive/session-runtime.test.ts`
- Modify: `src/cli/interactive/session.tsx`
- Modify: `src/cli/interactive/session.test.tsx`
- Modify: `src/cli/interactive/session-auth.test.tsx`
- Modify: `src/cli/main.ts`

**Interfaces:**

- Consumes: Task 2 operation-context handlers, Task 3 reducer/events, Task 4 navigation/rendering.
- Produces: `STARTUP_AUTH_TIMEOUT_MS = 5_000`, `runStartupAuth`, `createChildOperation`, and a Session that owns only active child cancellation while `signal` remains the lifetime parent.

- [ ] **Step 1: Write failing runtime deadline tests with fake timers**

```ts
it("renders first and marks auth unknown at the five-second deadline", async () => {
  vi.useFakeTimers();
  const authStatus = vi.fn(() => new Promise<ViewModel>(() => undefined));
  const events: SessionEvent[] = [];
  const run = runStartupAuth({
    handlers: handlers({ authStatus }),
    parentSignal: new AbortController().signal,
    attemptId: 1,
    dispatch: (event) => events.push(event),
  });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(events).toContainEqual({
    type: "AUTH_FAILED",
    attemptId: 1,
    errorCode: "STARTUP_AUTH_TIMEOUT",
  });
  await run;
});
```

The runtime promise must settle when its own deadline wins even if a fake handler ignores abort. Also test connected/not-connected/expired mapping, parent-abort shutdown without visible failure, timer cleanup, and late-result suppression.

- [ ] **Step 2: Write failing input-level login cancellation test**

Mount with real FakeInk stdin. Let `authStatus` resolve required, start `/auth login`, send Ctrl+C, and assert:

```ts
expect(loginSignal?.aborted).toBe(true);
expect(onSessionExit).not.toHaveBeenCalled();
expect(harness.stdout.output).toContain("Session remains active");
```

Also assert local `/progress` runs after startup auth timeout and disabled Find never calls `handlers.find`.

- [ ] **Step 3: Run runtime and session auth tests to observe failure**

Run: `npx vitest run src/cli/interactive/session-runtime.test.ts src/cli/interactive/session-auth.test.tsx src/cli/interactive/session.test.tsx`

Expected: FAIL because startup/runtime integration and child-only cancellation are absent.

- [ ] **Step 4: Implement child-controller ownership**

```ts
export const STARTUP_AUTH_TIMEOUT_MS = 5_000;

export function createChildOperation(parent: AbortSignal): {
  readonly controller: AbortController;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  parent.addEventListener("abort", abort, { once: true });
  if (parent.aborted) abort();
  return {
    controller,
    dispose: () => parent.removeEventListener("abort", abort),
  };
}
```

`runStartupAuth` races handler completion against a 5,000 ms deadline, aborts the child when the deadline wins, dispatches one attempt-scoped result, ignores late handler settlement, and clears timer/listener resources.

- [ ] **Step 5: Replace Session's scattered state with reducer/runtime**

Use `useReducer(sessionReducer, undefined, initialSessionState)`. On mount, call `runStartupAuth`. Store only the active foreground child in a ref. For each submitted command:

```ts
const child = createChildOperation(signal);
activeOperation.current = child.controller;
dispatch({ type: "OPERATION_STARTED", operationId, command, cancellable: true, ...loginSnapshot });
const result = await controller(parsed, {
  signal: child.controller.signal,
  onNotice: (view) => dispatchNotice(view),
});
```

In `finally`, dispose and clear the ref only if its operation ID is still current. Dispatch asynchronous completion events with operation IDs.

- [ ] **Step 6: Make Ctrl+C operation-scoped**

Idle Ctrl+C clears prompt. Busy Ctrl+C invokes `activeOperation.current?.abort()` and does not call an app-unmount callback. Remove `SessionProps.onCancel`. Login cancellation is rendered neutral and restores `authBeforeLogin`. Process parent abort continues to unmount through `main`'s existing lifetime listener.

- [ ] **Step 7: Integrate category/action focus**

Arrow from prompt focuses sidebar. Sidebar Enter selects the category and moves focus to its first action except Home. Action arrows change action index. Enabled action Enter fills the prompt and returns focus to prompt. Disabled action Enter appends/exposes its reason without calling a handler. Home clears prompt and returns to dashboard.

- [ ] **Step 8: Run focused session tests**

Run: `npx vitest run src/cli/interactive/session-runtime.test.ts src/cli/interactive/session-state.test.ts src/cli/interactive/session.test.tsx src/cli/interactive/session-auth.test.tsx`

Expected: PASS with fake timers restored in `afterEach` and no dangling promises/handles.

- [ ] **Step 9: Commit runtime integration**

```bash
git add src/cli/interactive/session-runtime.ts src/cli/interactive/session-runtime.test.ts
git add -p src/cli/interactive/session.tsx src/cli/interactive/session.test.tsx src/cli/interactive/session-auth.test.tsx src/cli/main.ts
git diff --cached
git commit -m "feat(tui): check auth without blocking session startup"
```

### Task 6: Prove Renderer, Offline, and Process Contracts End to End

**Files:**

- Modify: `src/cli/presentation/plain-renderer.test.ts`
- Modify: `src/cli/presentation/json-renderer.test.ts`
- Modify: `test/cli-built.test.ts`
- Modify: `test/e2e/auth-cli.test.ts`
- Modify: `test/e2e/workflows.test.ts`
- Modify: `src/cli/interactive/session-auth.test.tsx`

**Interfaces:**

- Consumes: completed application, handler, reducer, renderer, and runtime behavior.
- Produces: regression evidence for exact output, no implicit device flow, timeout release, login cancellation, and local offline operation.

- [ ] **Step 1: Add exact renderer regression assertions**

```ts
expect(renderPlain(notConnected)).toBe(
  "Not connected to GitHub\nRun 'kestrel auth login' to connect",
);
expect(JSON.parse(renderJson(notConnected))).toEqual({
  schemaVersion: 1,
  ok: true,
  data: notConnected,
});
```

Add equivalent expired/error envelope assertions. No JSON field may be added.

- [ ] **Step 2: Add deterministic built Find no-flow coverage**

Instrument the local GitHub test server so `/login/device/code` increments a counter. Run unauthenticated `find` without `--no-interactive`; assert `DM_GITHUB_AUTH_REQUIRED`, nonzero exit, and zero device-code requests.

- [ ] **Step 3: Add hanging-helper startup coverage**

Use the existing executable credential shim pattern. Its `credential fill` path writes a marker and remains alive until aborted. Spawn the built interactive CLI with `stdio: ["pipe", "pipe", "pipe"]`; `shouldStartSession([])` mounts Ink independently of TTY detection. Wait for `Checking auth`, then wait up to six seconds for `Auth status unavailable`. Send `/progress\r`; assert progress output appears. Send `/exit\r`; assert clean child exit and that the helper's exit marker proves cancellation released it.

- [ ] **Step 4: Add explicit login cancellation coverage**

Hold the local `/login/oauth/access_token` response after the authorization notice. Start the built interactive CLI with piped stdin, submit `/auth login`, wait for the real fixture URI/code, send `\u0003`, then submit `/progress`. Assert the same Kestrel process serves progress, the held request closes, and no credential is stored.

- [ ] **Step 5: Run integration tests**

Run: `npm run build`

Run: `npx vitest run src/cli/presentation/plain-renderer.test.ts src/cli/presentation/json-renderer.test.ts test/cli-built.test.ts test/e2e/auth-cli.test.ts test/e2e/workflows.test.ts src/cli/interactive/session-auth.test.tsx`

Expected: PASS; the device-flow request counter remains zero for startup and Find, and becomes one only for explicit login.

- [ ] **Step 6: Commit integration evidence**

```bash
git add -p src/cli/presentation/plain-renderer.test.ts src/cli/presentation/json-renderer.test.ts test/cli-built.test.ts test/e2e/auth-cli.test.ts test/e2e/workflows.test.ts src/cli/interactive/session-auth.test.tsx
git diff --cached
git commit -m "test(auth): cover offline interactive recovery"
```

### Task 7: Document Verified Behavior and Run the Integration Gate

**Files:**

- Modify: `README.md`
- Modify: `docs/troubleshooting.md`

**Interfaces:**

- Consumes: observed behavior from Tasks 1–6.
- Produces: user documentation and repository-wide verification evidence.

- [ ] **Step 1: Update README after smoke behavior passes**

Document this exact flow:

```text
Kestrel renders the interactive session immediately and checks GitHub status for up to five seconds. It never starts login automatically. If GitHub is required, select Auth, choose /auth login, then press Enter again to start the device flow. Local mission, progress, journey, and preference commands remain available while disconnected or offline.
```

Describe category selection, contextual action selection, prompt fill, and second-Enter confirmation. Do not claim session/device-flow resume.

- [ ] **Step 2: Update troubleshooting after smoke behavior passes**

Add recovery entries for:

- `Auth required` → select `/auth login` explicitly;
- `Auth status unavailable` → local work remains available; use `/auth status` to retry;
- login waiting for device authorization → Ctrl+C cancels only login;
- restart during login → start a new explicit login because authorization state is transient.

Preserve one-shot forms as `kestrel auth status` and `kestrel auth login`.

- [ ] **Step 3: Run focused tests once more after documentation command examples**

Run: `npx vitest run test/docs/commands.test.ts src/cli/interactive/session-auth.test.tsx test/e2e/auth-cli.test.ts`

Expected: PASS; every documented command parses and renderer spelling remains channel-correct.

- [ ] **Step 4: Run the built CLI in a real PTY**

Run `npm run build`, then launch `node dist/cli/main.js` in a real PTY. Observe the first frame before auth resolution. Exercise Auth → `/auth login` → second Enter, observe the GitHub verification URI/code, send Ctrl+C, then submit `/progress`. Required observations: the login poll ends, the same session remains visible, and progress renders. Exit with `/exit`. Do not complete the browser flow or store a new credential solely for this smoke.

- [ ] **Step 5: Run repository quality gates**

Run each command once, in order:

```bash
npm run boundaries
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build
```

Expected: all exit 0. Record the exact test file/test counts from `npm test`. Run `npm run check:runtime` only if runtime detection or package prerequisites changed during implementation.

- [ ] **Step 6: Review only the final implementation diff**

Verify no token, device code, generated `dist`, target repository content, compatibility alias, stale `requireGithubToken`, global handler signal fallback, or unrelated file is included. Confirm the original user-authored uncommitted changes remain present.

- [ ] **Step 7: Commit documentation and any final task-owned corrections**

```bash
git add -p README.md docs/troubleshooting.md
git diff --cached
git commit -m "docs: explain interactive authentication recovery"
```
