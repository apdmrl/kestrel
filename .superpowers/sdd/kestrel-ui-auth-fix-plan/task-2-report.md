# Task 2 Report: GitHub device-login default client ID

## Scope completed

- Added Kestrel's registered public OAuth App client ID at the existing `createConfig` composition boundary: `Ov23lizdZtG8goMx2GZC`.
- Kept an explicitly supplied `GITHUB_CLIENT_ID` as the overriding value.
- Made `KestrelConfig.githubClientId` required and passed it directly to `OctokitGateway`, so normal composition cannot silently substitute an empty client ID.
- Documented out-of-box login and the optional override in the README and troubleshooting guidance.

## TDD evidence

### RED

Before production edits, added `uses Kestrel's public OAuth client ID unless the environment overrides it` in `src/bootstrap/index.test.ts`.

Command:

```sh
npm test -- src/bootstrap/index.test.ts -t "uses Kestrel's public OAuth client ID"
```

Observed failure (exit 1):

```text
expected undefined to be 'Ov23lizdZtG8goMx2GZC'
```

The override assertion used a literal `test-client-id`; the missing-environment assertion failed because `createConfig({}).githubClientId` was previously `undefined`.

### GREEN

After the minimal configuration change, the same focused test passed:

```text
Test Files  1 passed (1)
Tests  1 passed | 28 skipped (29)
```

## Behavioral coverage retained and verified

The focused auth run includes the existing behavioral coverage for:

- one-shot device authorization guidance before the browser launch attempt;
- browser launch suppression and safe launch behavior;
- one-shot guidance placement that preserves JSON stdout;
- interactive `/auth login` delivery of device authorization guidance through the session notice channel;
- the strict interactive terminal-row rendering invariant.

No device-flow protocol, credential storage, URL validation, cancellation, JSON/non-interactive behavior, or secret-redaction code changed.

## Final focused verification

Command:

```sh
npm test -- src/bootstrap/index.test.ts src/cli/create-program.test.ts src/cli/interactive/session-auth.test.tsx
```

Observed clean result (exit 0):

```text
Test Files  3 passed (3)
Tests  81 passed (81)
```

## Self-review

Reviewed the changed configuration, composition regression, README, and troubleshooting text. The diff is limited to the Task 2 configuration/default, its focused regression coverage, and user-facing authentication setup guidance.

## Review follow-up: composition boundary

Added `composes default and explicit OAuth IDs into device authentication` in
`src/bootstrap/index.test.ts`. It runs `bootstrap` without an injected
`GitHubGateway`, exercises the real `OctokitGateway`, and observes its
device-auth factory receiving the default public ID and an explicit override.
The same default login asserts that the safe URI and user code guidance are
notices before the browser launch and that neither the device code nor token
reach those notices.

Targeted command:

```sh
npm test -- src/bootstrap/index.test.ts -t "composes default and explicit OAuth IDs"
```

Observed clean result (exit 0):

```text
Test Files  1 passed (1)
Tests  1 passed | 29 skipped (30)
```

## Commit

Committed as `fix: default GitHub OAuth client ID`.
