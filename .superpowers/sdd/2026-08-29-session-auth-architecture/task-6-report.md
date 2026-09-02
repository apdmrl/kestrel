# Task 6 Report: Renderer, Offline, Process, and End-to-End Contracts

## Scope

- Exact plain and JSON auth renderer contracts.
- Unauthenticated built `find` fails closed without a device-flow request.
- Piped built-process startup/termination releases a hanging credential helper; no pipe-driven interactive commands.
- FakeInk explicit-login cancellation keeps the session active, runs local progress, stores no credential, and preserves exact recommendation acceptance semantics.
- Built local-fixture flow: explicit `auth login --no-browser` → `find` → `mission accept --id <exact-id>`.

All HTTP, credential, and repository inputs are local test fixtures. No real GitHub request, credential, clone, fork, push, target dependency install, or target build/test occurs.

## RED Evidence

The first integrated focused run failed:

- `test/e2e/auth-cli.test.ts`: setup passed `undefined` to `createCredentialShim`, skipping 12 tests.
- Seven legacy `workflows.test.ts` scenarios still assumed `find` implicitly started device authorization, contradicting the Task 1 fail-closed contract.
- Ordinary `npm run build` exposed strict TypeScript errors in the credential guard, Ink optional color props, static navigation action availability, and connected-login narrowing.

The source errors were fixed without compiler suppression:

- credential lookup uses its current two-argument port API; cancellation remains on `getViewer`.
- Ink color props are omitted when colorization is disabled.
- every static `SessionAction` explicitly declares enabled availability.
- connected startup auth captures a narrowed non-null login.

Legacy workflow tests now use explicit auth login or a validated fixture credential according to the behavior under test. The new unauthenticated-find test remains fail-closed and asserts zero device requests.

## GREEN Evidence

```text
$ npm run build
> node scripts/clean.mjs dist && tsc -p tsconfig.build.json
(exit 0)

$ npx vitest run src/cli/presentation/plain-renderer.test.ts \
    src/cli/presentation/json-renderer.test.ts \
    test/cli-built.test.ts \
    test/e2e/auth-cli.test.ts \
    test/e2e/workflows.test.ts \
    src/cli/interactive/session-auth.test.tsx

Test Files  6 passed (6)
Tests       88 passed (88)
Duration    162.21s
```

The workflow file also passed independently: 47/47 tests in 135.68 seconds. The auth CLI file passed independently: 12/12 tests.

## Observable Assertions

- Renderer tests compare complete plain strings and exact schema-version-1 JSON envelopes; no JSON fields were added.
- Unauthenticated built `find` exits nonzero with `DM_GITHUB_AUTH_REQUIRED`; fixture `/login/device/code` counter remains zero.
- Explicit local-fixture login increments the device counter exactly once. Subsequent built `find` and exact-ID mission acceptance do not increment it.
- The credential shim records explicit approval and returns the same fixture token to later commands.
- The hanging credential helper records startup fill and signal-driven exit; the built parent exits within the bounded test timeout.
- FakeInk cancellation aborts the held login operation, leaves the session mounted, permits local progress, closes the held request, and does not store a credential.
- Recommendation acceptance uses the displayed exact ID: first Enter fills the prompt; second Enter invokes acceptance once.

## Process Deviations

Two Task 6 implementers stopped with incomplete uncommitted work. One temporarily changed the build script to emit despite errors; that out-of-scope change was removed before validation. A parallel compile-correction batch repaired four independent strict TypeScript errors, and a parallel E2E batch repaired auth CLI setup and migrated legacy workflow scenarios. One workflow agent was cancelled after becoming unresponsive; its completed edits were retained and independently verified.

## Review Fix Round

The scoped reviewer found four evidence/lifecycle gaps. Corrections:

- `CredentialStore.get` now accepts an abort signal; `GitCredentialStore`
  forwards it to `ProcessRunner.run`, and every auth caller propagates its
  operation signal. The hanging-helper test now requires a graceful bounded
  parent exit and `fill.exited`; no forced-kill or timeout result is accepted.
- Built E2E setup no longer catches build errors or silently reuses stale
  output. Auth CLI and workflow suites require a successful ordinary build.
- The FakeInk cancellation store assertion is attached to the held token
  promise's success branch; cancellation rejects before that branch. Mutation
  to resolve the promise makes the assertion fail.
- The stateful credential helper persists the exact `credential approve`
  payload and replays it on later `credential fill`; the test asserts the
  fixture account/token rather than fabricating them from a call counter.

Fresh evidence after these changes:

```text
$ npm run build
> node scripts/clean.mjs dist && tsc -p tsconfig.build.json
(exit 0)

Test Files  6 passed (6)
Tests       88 passed (88)
Duration    156.29s
```

Directly affected auth/credential/built tests also passed 52/52.
