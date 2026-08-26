# GitHub Browser Authentication Design

- **Date:** 2026-08-26
- **Status:** Design approved in chat
- **Scope:** Explicit GitHub authentication commands plus automatic browser launch for the existing OAuth device flow

## Problem

Kestrel already implements the GitHub OAuth device flow end to end: `OctokitGateway.beginDeviceFlow` and `pollForToken` obtain a token, `GitCredentialStore` persists it through the user's Git credential helper, and `authenticateGitHub` validates a cached token before reuse. Two gaps make that flow hard to use.

First, there is no way to authenticate deliberately. Authentication is an implicit side effect of `requireGithubToken()` in the composition root, triggered by the first command that happens to need GitHub. A user who wants to connect must run an unrelated command such as `kestrel find` and hope authentication happens. There is no way to check which account is connected, and no way to disconnect.

Second, the device flow prints the verification URI and user code as text on stderr and stops there. The user must copy a URL out of the terminal and open it themselves.

This design closes both gaps. It re-scopes the GitHub authentication work that `docs/superpowers/specs/2026-08-25-kestrel-persistent-shell-design.md` deferred as a non-goal, and that `docs/superpowers/plans/2026-08-25-kestrel-persistent-shell-resume.md` gated behind "a new approved design".

## Goals

- Add `kestrel auth login`, `kestrel auth status`, and `kestrel auth logout` on the Commander one-shot path.
- Add `/auth login`, `/auth status`, and `/auth logout` to the persistent Ink session.
- Open the user's browser to the device-flow verification URI automatically, while still printing the URI and user code.
- Let the user suppress the browser launch with `--no-browser`, `KESTREL_NO_BROWSER`, or `--json`.
- Route device-flow guidance through a view model so it renders correctly in the Ink session instead of corrupting the frame.
- State the blast radius of `auth logout` honestly and require explicit confirmation before clearing a shared credential.
- Preserve the existing plain and JSON output contracts, cancellation semantics, and secret-redaction guarantees.

## Non-goals

- A localhost OAuth loopback redirect flow. The device flow stays the only protocol.
- A `GITHUB_TOKEN` or personal-access-token environment path.
- Operation-scoped cancellation inside the session (residual item R1). See "Known limitations".
- A new credential storage schema, namespace, or file. Persistence stays delegated to `git credential`.
- Configurable OAuth scopes. `public_repo` remains hard-coded in `OctokitGateway`.
- Changing how implicit authentication in `find` and `verify` presents its guidance.

## Command surface

```
kestrel auth login     [--no-browser]           # run device flow, open browser, store token
kestrel auth status                             # validate the cached token against GitHub
kestrel auth logout --confirm github.com        # clear the stored credential
```

The root program gains `--no-browser` alongside the existing `--plain`, `--json`, and `--no-interactive`.

In the Ink session: `/auth login`, `/auth status`, `/auth logout github.com`.

### `auth login`

Runs `authenticateGitHub` with `interactive: true`. A valid cached token short-circuits the device flow and reports the existing identity, because `authenticateGitHub` already validates before reuse. When the device flow starts, Kestrel emits a device-authorization view model and attempts to open the browser.

Without `GITHUB_CLIENT_ID` the existing `DM_GITHUB_AUTH_REQUIRED` error surfaces unchanged. Under `--no-interactive` the existing non-interactive refusal applies.

### `auth status`

Reads the cached credential and calls `gateway.getViewer` to confirm it is still live, reporting one of three states:

| State           | Condition                                                                 |
| --------------- | ------------------------------------------------------------------------- |
| `CONNECTED`     | A credential exists and `getViewer` succeeds. Reports the live login.     |
| `NOT_CONNECTED` | No credential is stored.                                                  |
| `EXPIRED`       | A credential exists but GitHub rejected it with `DM_GITHUB_AUTH_EXPIRED`. |

`auth status` is a read command and **must not mutate credentials**. This is a deliberate divergence from `authenticateGitHub`, which deletes an expired credential before re-authenticating. Reporting `EXPIRED` without deleting keeps `status` free of side effects; the deletion still happens on the next `login`.

Any other gateway error propagates unchanged, so a network failure is reported as a network failure rather than being misreported as "not connected".

### `auth logout`

`GitCredentialStore` is host-scoped, not account-scoped: `get()` ignores its `account` argument and `delete()` issues `git credential reject` for `protocol=https host=github.com`. Clearing it therefore removes the `github.com` credential that `git push` and `gh` also use. Kestrel cannot narrow this without changing the credential key, which is out of scope.

The command is therefore explicit rather than convenient. Without `--confirm`, it fails with the existing `invalidInput` helper (`DM_ILLEGAL_TRANSITION`, category `INVALID_INPUT`, exit code 2) and the message names both the required token and the shared-credential consequence. The confirmation token is the literal host, `github.com`, so it is self-documenting and appears in the error that demands it. This follows the established `confirmRestart` pattern in `src/application/mission/prepare-mission.ts`.

Logging out when nothing is stored is not an error; it reports `LOGGED_OUT` idempotently.

## Architecture

Dependencies move toward the domain, as the existing layers require. Authentication is not a domain concept, so the domain layer is untouched.

```text
cli auth commands / session /auth
  -> CommandHandlers (authLogin, authStatus, authLogout)
  -> application/auth use cases
       authenticateGitHub (existing), getAuthStatus, logoutGitHub, shouldOpenBrowser
  -> ports: CredentialStore, GitHubGateway, BrowserLauncher
  -> infrastructure: GitCredentialStore, OctokitGateway, ProcessBrowserLauncher
```

### New port

`src/ports/browser-launcher.ts`

```ts
export interface BrowserLauncher {
  /** Attempt to open url. Resolves true when launched, false otherwise. Never throws. */
  open(url: string, signal?: AbortSignal): Promise<boolean>;
}
```

Returning a boolean rather than throwing is the central contract decision. A failed browser launch must never fail an authentication that can still be completed by hand, and the caller needs the outcome to decide whether to say "opened your browser". "Never throws" is part of the interface, not an implementation detail, and is asserted by adapter tests.

### New application units

`src/application/auth/browser-launch-policy.ts`

```ts
export interface BrowserLaunchContext {
  readonly noBrowserFlag: boolean;
  readonly envDisabled: boolean;
  readonly json: boolean;
  readonly interactive: boolean;
}
export function shouldOpenBrowser(context: BrowserLaunchContext): boolean;
```

Pure and total. False when any of `noBrowserFlag`, `envDisabled`, or `json` is true, or when `interactive` is false. `json` suppresses the launch because JSON is the machine contract and a surprise GUI launch is wrong for an automated caller. `interactive: false` can never reach the device flow today, but encoding it keeps the policy total and independently testable. Keeping this out of the CLI honors the rule that presentation code makes no decisions.

`src/application/auth/get-auth-status.ts` and `src/application/auth/logout-github.ts` implement the two behaviors above. `logoutGitHub` exports `logoutConfirmationToken()` and `confirmLogout(token)` so the CLI never hard-codes the literal.

### New infrastructure adapter

`src/infrastructure/system/process-browser-launcher.ts`, built on the existing `ProcessRunner`, which is argv-only with `shell: false` and therefore carries no shell-injection surface. The command is selected from `detectPlatform().kind`:

| Platform | Executable and arguments                          |
| -------- | ------------------------------------------------- |
| `linux`  | `xdg-open <url>`                                  |
| `darwin` | `open <url>`                                      |
| `win32`  | `rundll32.exe url.dll,FileProtocolHandler <url>`  |
| `wsl`    | `wslview <url>`, falling back to `xdg-open <url>` |

Windows uses `rundll32` rather than `cmd /c start` deliberately: `start` is a `cmd.exe` builtin, which would require a shell and would mangle URLs containing `&`.

The launch is awaited with a bounded 10-second timeout. All four commands are dispatchers that hand off to the desktop and exit immediately rather than being the browser process itself, so the kill that `ExecaProcessRunner` performs on timeout cannot close the user's browser. Non-zero exits, missing executables, timeouts, and cancellations all resolve to `false`.

Platform command selection lives in this adapter rather than as a new `PlatformDescriptor` field, keeping the logic beside its only consumer and directly unit-testable.

### Presentation

Two new view models in `src/cli/presentation/view-models.ts`:

```ts
export interface DeviceAuthorizationViewModel {
  readonly kind: "device-authorization";
  readonly verificationUri: string;
  readonly userCode: string;
  readonly browserOpened: boolean;
}

export interface AuthStatusViewModel {
  readonly kind: "auth-status";
  readonly connected: boolean;
  readonly login: string | null;
  readonly detail: "CONNECTED" | "NOT_CONNECTED" | "EXPIRED" | "LOGGED_OUT";
}
```

One `AuthStatusViewModel` serves `login`, `status`, and `logout`, so there is exactly one JSON shape for authentication state. Both are rendered by `renderPlain` and carried by `renderJson` inside the existing `{ schemaVersion: 1, ok: true, data }` envelope, so the machine contract gains fields without changing shape.

### Threading device-flow guidance

`writeAuth` currently writes raw text to stderr. Inside the Ink session that bypasses the render tree and corrupts the frame. Rather than mutating a shared sink after bootstrap, `authLogin` accepts an explicit per-invocation callback:

```ts
readonly authLogin: (args: {
  onDeviceAuthorization?: (view: DeviceAuthorizationViewModel) => void;
}) => Promise<ViewModel>;
```

- The Commander path renders the view model with `renderPlain` to **stderr**, never stdout, preserving the guarantee that `--json` stdout is a single parseable document.
- The session path appends a transcript entry, so guidance renders inside the Ink frame.

Implicit authentication in `find` and `verify` keeps the existing string `writeAuth` sink unchanged. Two mechanisms coexist deliberately: converting the implicit path would thread a callback through every handler that might touch GitHub, for no user-visible gain, and would churn the existing bootstrap tests.

### Configuration and wiring

- `createConfig` reads `KESTREL_NO_BROWSER` into `KestrelConfig.noBrowser`.
- `BootstrapOptions` gains `openBrowser?: boolean` and `browserLauncher?: BrowserLauncher`, matching the existing `gateway` and `credentialStore` override pattern used by tests.
- `main.ts` derives the flags from `argv` exactly as it already derives `interactive` from `--no-interactive`, then passes `shouldOpenBrowser(...)` to bootstrap.
- The guidance view model is emitted **before** the launch is attempted, so a slow or failed launch never delays the user seeing the code. `browserOpened` is therefore reported by a second emission after the attempt resolves.

## Security

- **URL validation fails closed.** The launcher parses the URI with `new URL()` and launches only when the protocol is exactly `https:`, the hostname is non-empty, and no userinfo is present. `javascript:`, `file:`, `data:`, and malformed URIs are refused and resolve to `false`. This matters because `verification_uri` originates from the server named by `GITHUB_API_URL`, which a hostile or misconfigured environment controls. The refused URI is still printed as inert text so a legitimate GitHub Enterprise user is not blocked.
- **Userinfo is refused.** `https://user:pass@host/` would leak a credential into argv and the browser's history, and `https://github.com@evil.example/` reads as GitHub while resolving to `evil.example`. The Git client adapter already refuses userinfo in remote URLs, so this matches existing precedent. Note that Node's URL parser makes the empty-hostname case unreachable for `https:` (it throws), so that half of the check is defense in depth rather than a tested path.
- **No secret reaches the launcher.** Only the verification URI is passed as an argument. The device code and access token are never passed to a subprocess, printed, or logged, preserving the existing guarantees in `docs/security.md`.
- **`auth status` reports the login only.** Never the token, never the credential.
- **Arguments, never a shell.** The launch goes through `ProcessRunner`, which forbids shell command strings.

## Error handling and cancellation

- Existing codes are reused; no new `ErrorCode` is added. `DM_GITHUB_AUTH_REQUIRED` for a missing client id or non-interactive login, `DM_GITHUB_AUTH_EXPIRED` for a rejected token, `DM_GITHUB_AUTH_CANCELLED` for an interrupted device flow (exit 130), `DM_ILLEGAL_TRANSITION` with category `INVALID_INPUT` for a missing logout confirmation (exit 2).
- Browser-launch failures are never errors. They resolve to `false` and are reported as the absence of "opened your browser".
- `SIGINT` and `SIGTERM` continue to abort the device flow through the existing signal plumbing. A signal observed during a browser launch resolves the launch to `false`; the cancellation still surfaces from the subsequent `pollForToken`, so it is never swallowed.
- The launcher swallows `DM_PROCESS_CANCELLED` from the runner by design. Cancellation remains observable because the operation that follows it observes the same signal.

## Known limitations

**Session cancellation (residual item R1).** The Ink session shares one process-wide `AbortController`, and `AbortSignal` is one-shot. Cancelling `/auth login` with Ctrl+C therefore leaves the signal aborted, which would make every later command in the session fail. Until R1 designs an operation-scoped cancellation boundary, Ctrl+C during `/auth login` cancels the login and **closes the session**, matching today's one-shot semantics. This is documented rather than papered over: a session that appeared to survive would be lying about its own state.

**Logout blast radius.** `auth logout` clears the shared `github.com` credential. This is mitigated by explicit confirmation and a message that names the consequence, not by narrowing the credential key.

## Testing

Following the repository test-flow matrix, each change is proved by the smallest flow that demonstrates it.

| Unit                      | Evidence                                                                                                                                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser-launch-policy`   | Full suppression matrix: enabled by default, and disabled by each of flag, env, json, non-interactive, independently and in combination.                                                                                         |
| `ProcessBrowserLauncher`  | Exact argv per platform kind; WSL fallback to `xdg-open`; refusal of `http:`, `javascript:`, `file:`, `data:`, and malformed URIs; non-zero exit, runner throw, timeout, and cancellation each resolve `false`; never throws.    |
| `getAuthStatus`           | `CONNECTED` with the live login; `NOT_CONNECTED` with no credential; `EXPIRED` on `DM_GITHUB_AUTH_EXPIRED` **with the credential left intact**; unrelated gateway errors propagate; signal is forwarded.                         |
| `logoutGitHub`            | Deletes on a matching token; refuses with `INVALID_INPUT` and performs no deletion on a missing or wrong token; idempotent when nothing is stored.                                                                               |
| View models and renderers | Plain and JSON output for both new view models, including `browserOpened` true and false and all four `detail` values.                                                                                                           |
| Bootstrap wiring          | `authLogin` launches the browser with the verification URI; each suppression path performs zero launches; guidance is still emitted when the launch fails; neither the device code nor the token is ever passed to the launcher. |
| `create-program`          | `auth login`, `auth status`, `auth logout` parse; `--no-browser` parses; `auth logout` without `--confirm` exits 2; device guidance goes to stderr and `--json` stdout stays a single document.                                  |
| Session                   | Parser accepts and rejects the `/auth` forms; controller routes each to the matching handler; the transcript renders a device-authorization entry; Ctrl+C during `/auth login` closes the session.                               |
| Built CLI E2E             | `kestrel auth status --json` against the existing fake GitHub server and fake `git` credential shims; `auth logout` without `--confirm` exits 2; `--no-browser` accepted; no token or device code in any output.                 |

## Documentation

`docs/troubleshooting.md` gains the `auth` commands and the browser-suppression controls. `docs/security.md` gains the https-only launch rule and the statement that no secret is passed to a subprocess. `README.md` gains the connect-to-GitHub sequence. `CHANGELOG.md` records the new commands and flag.
