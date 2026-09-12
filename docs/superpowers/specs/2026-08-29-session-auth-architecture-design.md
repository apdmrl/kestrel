# Interactive Session and Authentication Architecture

**Date:** 2026-08-29
**Status:** Approved design; implementation not started

## 1. Purpose

Kestrel's interactive session must expose its primary workflows through the left navigation, establish GitHub authentication state without delaying startup indefinitely, and keep local workflows usable when GitHub is unavailable. Authentication must remain explicit and user-controlled: startup may check status, but only `/auth login` may begin a browser/device flow.

This design preserves Kestrel's local-first behavior, fail-closed external boundaries, cancellation propagation, durable mission recovery, and existing plain and JSON output contracts.

## 2. Goals

- Render the interactive session immediately and check authentication silently in the background.
- Bound startup authentication status work to five seconds.
- Show connected, required, expired, unknown/offline, and login-in-progress states explicitly.
- Never start device login during startup or as a side effect of `find`.
- Keep GitHub-independent local workflows enabled in every non-terminal auth state.
- Disable GitHub-dependent actions when authentication cannot be verified and present the correct recovery action.
- Let the user cancel a foreground login without closing the session.
- Reconstruct auth state after restart from the credential store and live validation rather than persisted React/session state.
- Preserve existing interactive, plain, `--json`, and `--no-interactive` behavior contracts.
- Make sidebar categories expose contextual primary actions without expanding every subcommand into the 32-line navigation area.

## 3. Non-goals

- A durable terminal-session schema.
- Resuming a device authorization code after process restart.
- Background command concurrency or a task manager.
- Automatic authentication retries, backoff, or browser/device flow at startup.
- Allowing stale last-known authentication to enable GitHub operations while offline.
- Changing mission, journal, lock, recommendation, handoff, preferences, or journey persistence formats.
- Changing the JSON schema version or adding fields to existing JSON envelopes.
- Authenticating target repositories, cloning forks, pushing, opening pull requests, or running target-repository builds/tests.

## 4. Decisions and alternatives

### 4.1 Selected: session-owned orchestration, application-owned auth policy

The interactive session owns transient presentation state and foreground-operation lifecycle. Application use cases own authentication validation, command prerequisites, and classified recovery errors. Infrastructure continues to implement credential, GitHub, process, and browser ports.

This keeps Ink concerns out of application code, keeps authentication decisions out of render components, and avoids inventing durable session semantics.

### 4.2 Rejected: application-level session coordinator

A general session coordinator would centralize snapshots but would also pull prompt, focus, transcript, and Ink lifecycle concerns toward the application layer. Kestrel does not yet have a persistent terminal shell, so this abstraction would assume future persistence and concurrency contracts that do not exist.

### 4.3 Rejected: bootstrap auth preflight

Waiting for authentication before rendering would let credential helpers or the network delay startup. It would also duplicate state management after login/logout and encourage authentication policy in the composition root. Startup must render first, then check with a bounded child operation.

## 5. Layer and component boundaries

### 5.1 Application auth use cases

`getAuthStatus` retains its current read-only live-validation behavior:

- Read the configured credential through `CredentialStore`.
- Return `NOT_CONNECTED` without a GitHub request when no credential exists.
- Validate a stored token through `GitHubGateway.getViewer`.
- Return `CONNECTED` with the live login when validation succeeds.
- Return `EXPIRED` for a revoked or expired stored token without deleting it.
- Propagate cancellation, network, credential-helper, and other classified failures rather than reporting them as `NOT_CONNECTED`.

The five-second startup deadline does not belong inside `getAuthStatus`; it is an interactive-session policy. One-shot `kestrel auth status` retains its existing behavior.

`authenticateGitHub` remains the only use case allowed to begin device flow. It runs only after an explicit login command, may reuse a valid cached credential, reports safe authorization guidance, polls for completion, and stores the resulting credential. Tokens and device codes never cross into presentation models.

### 5.2 Validated credential guard

The existing `requireGithubToken` responsibility is split. GitHub-dependent operations use a guard that may:

- read a credential;
- validate it;
- return its token;
- raise `DM_GITHUB_AUTH_REQUIRED` when absent;
- raise `DM_GITHUB_AUTH_EXPIRED` when invalid;
- propagate network, timeout, cancellation, and provider errors.

The guard must not call `beginDeviceFlow`, `pollForToken`, or `authenticateGitHub`. `find` therefore cannot trigger login implicitly. It must not construct a challenge source until the guard returns a validated token.

### 5.3 Operation-scoped command context

`CommandHandlers` remains the shared boundary used by one-shot commands and the interactive controller. Cancellation moves from bootstrap's single captured signal to a per-invocation context:

```ts
interface CommandContext {
  readonly signal?: AbortSignal;
  readonly onNotice?: (view: ViewModel) => void;
}
```

Every handler accepts its command arguments as its first parameter and a `CommandContext` as its second parameter. Handlers with no command-specific arguments receive an empty object first. Every invocation receives its own operation signal, and all affected callers migrate in one clean cutover. No compatibility overload or global-signal fallback remains.

The signal continues through application use cases, ports, credential helpers, process execution, browser launch, and GitHub requests.

### 5.4 Interactive runtime and reducer

The interactive layer is divided into:

- `Session`: Ink composition and input binding.
- `useSessionRuntime`: startup auth effect, foreground command lifecycle, child-controller ownership, deadlines, and dispatching runtime events.
- `sessionReducer`: pure state transitions for auth presentation, selected section/action, focus, prompt, transcript, command queue, and foreground operation.
- `createSessionController`: parsed command routing to `CommandHandlers`.
- `DashboardShell`: pure rendering from immutable props/view models.
- `renderSessionView`: interactive-specific rendering and recovery actions.

The reducer performs no filesystem, network, process, browser, or credential effects.

### 5.5 Abort hierarchy

```text
Process AbortController
└── Session lifetime
    ├── Startup auth child controller and five-second deadline
    ├── Login child controller
    └── Current foreground-command child controller
```

A parent abort propagates to every active child. Ctrl+C handled by the interactive session while busy aborts only the foreground child. It does not abort the process/session controller or unmount Ink. SIGINT/SIGTERM reaching the process lifetime controller retains the existing graceful first-signal and forced second-signal policy.

## 6. Authentication state machine

```ts
type SessionAuthState =
  | { status: "checking"; attemptId: number }
  | { status: "connected"; login: string }
  | { status: "required" }
  | { status: "expired" }
  | { status: "unknown"; errorCode: string }
  | {
      status: "logging-in";
      phase: "starting" | "awaiting-user";
      authorization?: {
        verificationUri: string;
        userCode: string;
        expiresAt: number;
      };
    };
```

`deviceCode` and access tokens never enter session state. `expiresAt` is calculated in memory from the safe `expiresInSeconds` value and exists only to present the authorization deadline.

### 6.1 Startup transitions

1. Session renders immediately with `checking`.
2. The runtime creates a startup child controller, links it to the parent, and starts a five-second timer.
3. It calls `authStatus` with the child signal.
4. `CONNECTED` transitions to `connected(login)`.
5. `NOT_CONNECTED` transitions to `required`.
6. `EXPIRED` transitions to `expired`.
7. Network, credential-helper, provider, or runtime-deadline failure transitions to `unknown(errorCode)`.
8. Parent cancellation causes shutdown without dispatching a new visible auth state.
9. The timer and abort listeners are removed in every completion path.

Every status attempt has a monotonically increasing `attemptId`. The reducer ignores results from stale attempts, including work that resolves after the local deadline.

The deadline abort does not delete credentials or mutate durable state. The runtime knows whether its own deadline fired and therefore does not infer timeout semantics from an adapter's cancellation code.

### 6.2 Login transitions

An explicit `/auth login`:

1. Stores the pre-login auth state in the foreground operation.
2. Creates an operation child controller.
3. Transitions to `logging-in(starting)`.
4. On authorization notice, transitions to `logging-in(awaiting-user)` and exposes only verification URI, user code, and expiry.
5. Opens a browser only when the existing browser-launch policy permits it.
6. On successful token storage and identity validation, transitions to `connected(login)`.
7. On Ctrl+C, aborts the login child, emits a neutral cancellation notice, and restores the exact pre-login auth state.
8. On network, provider, device-authorization expiry, or timeout failure, restores the exact pre-login auth state and presents the classified error. The user may explicitly run `/auth status` afterward; only that live check may change the restored state to `connected`, `required`, `expired`, or `unknown`.

Device authorization expiry is not stored-credential expiry. It is a failed login attempt whose recovery action is another explicit `/auth login`; it does not by itself transition auth to `expired`.

Only one foreground command may run. Login is foreground and cancellable. Other commands and a second login cannot start until it completes or is cancelled.

### 6.3 Command-result effects

- Successful `/auth status` replaces auth state with its result.
- Successful `/auth login` sets `connected`.
- Successful `/auth logout` sets `required`.
- Credential validation returning `DM_GITHUB_AUTH_REQUIRED` sets `required`.
- Credential validation returning `DM_GITHUB_AUTH_EXPIRED` sets `expired`.
- A local command does not modify auth state.
- Cancelling a non-auth command does not modify auth state.
- A later GitHub operation failure, such as search timeout after credential validation, does not change auth state. The application boundary must preserve whether an error arose from credential validation or from the requested operation rather than treating every GitHub error as auth uncertainty.

## 7. General operation state

```ts
type OperationState =
  | { status: "idle" }
  | {
      status: "running";
      operationId: number;
      command: string;
      cancellable: boolean;
      authBeforeLogin?: SessionAuthState;
    };
```

Operation IDs prevent late completions from overwriting a newer session state. Pasted commands retain sequential queue behavior. An auth-blocked command never injects login into the queue automatically.

## 8. Navigation and capability behavior

The sidebar represents categories, not one fixed command per row. Categories include Home, Find, Mission, Agent, Verify, Progress, Journey, Auth, and Preferences. The active category renders contextual actions in the main panel.

```ts
interface NavigationSection {
  readonly id: string;
  readonly label: string;
  readonly requires?: "github";
  readonly actions: readonly SessionAction[];
}

interface SessionAction {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly availability: ActionAvailability;
}

type ActionAvailability =
  | { status: "enabled" }
  | {
      status: "disabled";
      reason: string;
      recoveryCommand?: string;
    };
```

This metadata provides early interactive feedback only. The application credential guard remains authoritative when a command is typed manually, pasted, or invoked through the plain CLI.

### 8.1 Activation model

- Enter on a sidebar row selects its category.
- Enter on a contextual action fills the prompt.
- A second Enter submits the command.
- Disabled actions are focusable so their reason can be inspected, but they do not fill the blocked command and do not call a handler.
- Selecting a recovery action fills `/auth login` or `/auth status`; it still requires the second Enter.
- Home clears the prompt and restores the dashboard panel.

### 8.2 Auth contextual actions

| State        | Primary action        | Secondary actions                |
| ------------ | --------------------- | -------------------------------- |
| `checking`   | Status shown disabled | none                             |
| `required`   | `/auth login`         | `/auth status`                   |
| `expired`    | `/auth login`         | `/auth status`, confirmed logout |
| `unknown`    | `/auth status`        | `/auth login`                    |
| `connected`  | `/auth status`        | confirmed logout                 |
| `logging-in` | Cancel instruction    | other auth actions disabled      |

GitHub-dependent categories are disabled during `checking`, `required`, `expired`, `unknown`, and `logging-in`. Local categories remain enabled unless a foreground operation temporarily owns command execution.

## 9. Recovery presentation

### 9.1 Renderer separation

The interactive session stops using `renderPlain` as its general renderer. Presentation paths become:

- Plain renderer: shell-oriented recovery commands such as `kestrel auth login`.
- JSON renderer: the existing versioned machine envelope.
- Interactive renderer: slash commands such as `/auth login` and contextual prompt actions.

`renderSessionView` maps stable error codes and auth view models to interactive content. Application errors do not choose a shell or slash-command syntax.

### 9.2 Required and expired

Required state explains that GitHub is needed for Find, keeps local features available, and offers `/auth login` plus `/auth status`. Expired state offers explicit reauthentication. Startup status remains read-only; expired credentials are deleted only during an explicit login according to the existing login policy.

### 9.3 Unknown/offline

Unknown state states that authentication could not be verified before the startup deadline or because an external dependency failed. GitHub actions remain fail-closed. `/auth status` is the primary recovery action; `/auth login` is secondary and remains explicit. No automatic retry is scheduled.

### 9.4 Cancellation

`DM_GITHUB_AUTH_CANCELLED` has informational severity and is rendered as a neutral transcript notice, not a red action-required card. The message confirms that login was cancelled and the session remains active.

## 10. Plain, JSON, and non-interactive contracts

The implementation must not change:

- JSON `schemaVersion: 1`.
- JSON `ok`, `data`, and `error` envelope structure.
- Existing `AuthStatusViewModel` fields and detail values.
- Existing error codes and `suggestedActions` array shape.
- ANSI-free plain output.
- Shell-oriented plain recovery command spelling.
- `--json` browser/device-flow suppression.
- `--no-interactive` refusal to begin device flow.

No recovery metadata is added to the JSON envelope in this change. Interactive recovery metadata remains inside the interactive presentation adapter.

## 11. Offline, restart, and durable state

The following are transient and are never persisted:

- checking, unknown, and logging-in auth states;
- authorization URI, user code, and expiry;
- selected menu section/action;
- prompt and transcript;
- command queue and operation IDs;
- AbortControllers and timers.

Existing durable facts remain unchanged: credentials in the configured helper, mission checkpoints, sidecars, locks, journals, recommendations, handoffs, preferences, and journey evidence.

After restart:

- An unfinished device flow is abandoned.
- A token stored successfully before interruption is discovered and validated by startup status.
- A token not stored before interruption leaves no session recovery record.
- Journal recovery retains its existing bootstrap ordering and finishes before the Session renders.
- Startup auth checking begins only after bootstrap recovery and Session mount.

## 12. Input, cancellation, and exit behavior

| Input                  | Idle                       | Foreground command     | Login                           |
| ---------------------- | -------------------------- | ---------------------- | ------------------------------- |
| Ctrl+C in Ink          | clear prompt; keep session | abort current child    | abort login child; keep session |
| `/exit`                | close session              | unavailable while busy | unavailable while busy          |
| Process SIGINT/SIGTERM | abort lifetime and close   | abort parent and child | abort parent and login child    |
| Second process signal  | force exit 130             | force exit 130         | force exit 130                  |

Ink input cancellation and process-signal cancellation are separate test cases. The first is operation-scoped; the second is lifetime-scoped.

## 13. Verification contract

### 13.1 Application tests

- Missing credential raises `DM_GITHUB_AUTH_REQUIRED`.
- Revoked/expired credential raises `DM_GITHUB_AUTH_EXPIRED`.
- Credential-validation network errors remain classified network errors.
- The validated credential guard never begins or polls device flow.
- `find` does not construct a challenge source without a validated token.
- Explicit `authLogin` is the only handler path that begins device flow.
- Operation signals reach credential, GitHub, process, and browser adapters where applicable.
- Cancelled login does not store a credential.

### 13.2 Reducer tests

Table-driven tests cover:

- every startup result;
- stale auth attempts and stale operation completions;
- connected to logged-out/required;
- unknown to checking to connected;
- login cancellation restoring every possible pre-login state;
- credential-validation errors versus post-auth operation errors;
- local commands preserving auth state.

### 13.3 Interactive tests

- First frame renders before auth status resolves.
- Checking, required, expired, unknown, connected, and logging-in states render correctly.
- Auth category exposes the correct contextual actions.
- Disabled Find does not call its handler and presents recovery.
- Recovery selection fills but does not execute the command.
- Ctrl+C cancels login while Session remains mounted.
- Device URI and user code appear once.
- Interactive auth recovery never recommends `kestrel auth login`.
- Home clears prompt and restores the dashboard.

### 13.4 Plain and JSON regression tests

Exact-output tests cover auth status variants, auth-required Find, non-interactive login, JSON envelope shape, browser suppression, and preservation of shell-oriented suggested actions.

### 13.5 Built CLI and PTY smoke

- The TUI renders immediately with a slow or hanging credential helper.
- Startup reaches unknown/offline after five seconds rather than hanging.
- A local command such as `/progress` runs afterward.
- Auth-required `/find` does not begin device flow.
- Explicit `/auth login` presents the real verification URI and user code.
- Ctrl+C during device polling returns to the active session rather than exiting.
- Process termination closes device polling and credential-helper subprocesses.

Applicable integration checks remain `npm run boundaries`, `npm run lint`, `npm run format:check`, `npm run typecheck`, focused tests, `npm test`, and `npm run build`. Runtime prerequisite checks apply if implementation changes runtime detection or packaging.

## 14. Documentation

After behavior is implemented and verified:

- Update `README.md` with interactive startup, navigation, and explicit authentication flow.
- Update `docs/troubleshooting.md` with unknown/offline state, five-second startup deadline, manual status retry, and cancellation behavior.
- Preserve existing plain and JSON command documentation.
- Do not claim durable session or resumable device authorization support.

## 15. Acceptance criteria

1. The interactive UI renders before startup auth validation completes.
2. At the five-second startup deadline, the UI transitions to unknown/offline, aborts the child operation, and ignores late completion. Cancellation-aware credential, process, and network adapters release their active resources.
3. No startup path begins device authorization or opens a browser.
4. `find` without validated authentication fails closed and never begins device flow.
5. Local commands remain available when auth is required, expired, or unknown.
6. Auth and other sidebar categories expose contextual actions; selecting an action fills the prompt and requires a second Enter.
7. Explicit login is foreground, clearly presented, and cancellable without closing the session.
8. Login, logout, status, and credential-validation outcomes update session auth state deterministically.
9. Restart reconstructs auth from credentials and live validation without new durable session state.
10. Interactive recovery uses slash commands; plain recovery uses shell commands; JSON schema version 1 remains unchanged.
11. Cancellation reaches every external call and subprocess in the active operation.
12. Focused application, reducer, component, renderer, built-CLI, and PTY scenarios prove the observable behavior.
