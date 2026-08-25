# Kestrel Persistent Shell Design

- **Date:** 2026-08-25
- **Status:** Design approved in chat; awaiting written-spec review
- **Scope:** Shell-first milestone for a persistent Ink terminal session

## Problem

Kestrel currently exposes Commander-based one-shot commands and a small set of Ink prompts. It does not yet provide a persistent terminal session where a user can enter multiple commands, see a transcript, and leave with `exit`. The first milestone must add that shell without changing mission lifecycle, recovery, cancellation, or existing plain/JSON command contracts.

GitHub authentication, new persistent authentication/session schemas, and new mission behavior are explicitly outside this milestone.

## Goals

- Open a persistent Ink session when `kestrel` is invoked without positional arguments.
- Keep existing argument-bearing invocations on the Commander one-shot path.
- Use slash commands such as `/find`, `/progress`, `/help`, `/clear`, and `/exit`.
- Reuse existing `CommandHandlers`, view models, plain rendering, cancellation, bootstrap, and recovery behavior.
- Render a transcript with a fixed bottom prompt using a restrained Matrix-green terminal theme.
- Keep the session safe: no arbitrary shell execution and no durable mutation for session-local commands.
- Provide focused parser, controller, component, and real-process smoke coverage.

## Non-goals

- GitHub login/logout or authentication UI.
- A persistent session-storage schema.
- Arbitrary shell command execution.
- Mission lifecycle changes.
- A JSON session renderer.
- A right-side dashboard or full-screen multi-pane layout.
- New application use cases or duplicate session-specific domain decisions.

## Architecture

The session is a CLI presentation/controller layer. Application and domain decisions remain in their existing layers. The implementation follows the current dependency direction:

```text
cli interactive session
  -> session controller/parser
  -> existing CommandHandlers
  -> application/domain through existing bootstrap wiring
  -> ViewModel
  -> plain renderer
  -> transcript
```

### Components

#### `src/cli/interactive/session.tsx`

Owns the Ink lifecycle and visible session state: transcript entries, input buffer, busy/ready state, and graceful exit. It renders the header, transcript, prompt, and session-local messages. It handles Enter, `/`, Escape, and Ctrl+C behavior without making domain decisions.

#### `src/cli/interactive/session-parser.ts`

Parses slash commands into a typed command name plus arguments/options. It supports the documented session command grammar, deterministic whitespace and quoted-value handling, and rejects non-slash input and unknown options. It never executes shell text.

#### `src/cli/interactive/session-controller.ts`

Maps parsed commands to existing `CommandHandlers`. The mapping is explicit rather than invoking Commander inside Ink. It supports the existing command families needed by the session:

- `/find [--mood <mood>] [--type <type>]`
- `/current`
- `/mission <accept|prepare|resume|current|complete|abandon|break-lock> ...`
- `/agent brief ...`
- `/verify <submission|link|merge> ...`
- `/journey`
- `/progress`
- `/preferences <get|set> ...`

Session-local commands are `/help`, `/clear`, `/exit`, and `/quit`.

#### `src/cli/interactive/session-view-models.ts`

Defines presentation-only transcript/session types. It converts handler results or errors into entries suitable for rendering, without introducing domain decisions.

#### `src/cli/main.ts`

Selects the execution path. A bare `kestrel` starts the persistent session. Any argument-bearing invocation, including `--json` and `--no-interactive`, keeps the existing Commander behavior. Bootstrap, recovery, signal handling, and handler wiring remain shared and are not repeated per command.

## Session behavior

The visible layout is transcript plus a fixed prompt:

```text
 KESTREL  /  LOCAL ENGINEERING COMPANION
 workspace: ~/projects/kestrel                 session: ready

 ✓ Welcome back
   Type /help to see commands.

 kestrel › /progress
 Journey progress
   Prepared       3
   In progress    1
   Completed      8

 kestrel › _
```

- Enter submits the current slash command.
- `/help` prints a concise command list.
- `/clear` clears only the visual transcript.
- `/exit` and `/quit` use the same graceful unmount path.
- Non-slash input is rejected with a short `/help` hint; it is never passed to a shell.
- Output is rendered through the existing plain renderer and appended to the transcript.
- Handler errors are rendered through the existing error view model and do not close the session.
- The prompt returns after successful completion or handled error.
- Transcript history has a bounded in-memory visual limit to prevent unbounded React state growth. This limit does not affect durable mission/application state.

## Cancellation and lifecycle

The existing `AbortController` remains the cancellation source.

- While a handler is running, Ctrl+C aborts the active operation and allows existing lock/recovery unwinding to run.
- While the prompt is idle, Ctrl+C clears the input buffer and leaves the session open.
- `/exit` does not create a mission transition, journal intent, or recovery record.
- Session unmount removes input and signal listeners and returns control to the process entry point.
- A second OS signal retains the current forced-exit behavior from `main.ts`.
- Recovery/bootstrap initialization occurs once for the process, not once per slash command.

## Visual system

Use a Matrix-green palette on a dark terminal background:

- bright green for title and primary success
- medium green for prompt and active state
- muted green-gray for metadata and guidance
- yellow/red only for warnings/errors
- symbols and text preserve meaning when color is unavailable (`✓`, `!`, `×`)

Avoid fixed-width panels. Long output wraps naturally to terminal width. Header/status content simplifies in narrow terminals. No right-side panel is required in this milestone.

## Error handling

- Parser errors do not invoke handlers and become transcript usage errors.
- Unknown command and malformed option errors remain inside the session.
- Handler errors use the existing `errorViewModel` and plain renderer path.
- Cancellation returns to the prompt only after the handler has unwound according to the existing cancellation contract.
- Session-local commands do not invoke bootstrap or recovery again.

## Testing and acceptance

### Parser/controller

- Parse all session-local commands and supported nested command families.
- Reject non-slash input, unknown commands, missing required values, and unknown options without calling handlers.
- Preserve quoted values and deterministic whitespace behavior.
- Map each supported command to the correct existing handler input.
- Never execute arbitrary shell text.

### Ink components

- Render header, welcome state, transcript, and fixed `kestrel ›` prompt.
- Append successful output and handled errors without unmounting.
- Clear transcript with `/clear`.
- Call exit exactly once for `/exit` and `/quit`.
- Clear idle input on Ctrl+C.
- Return to the prompt after active-command cancellation.
- Preserve meaning without relying on color.

### Real CLI smoke/integration

- Start the built `kestrel` process, submit `/help`, `/progress`, and `/exit`, and observe clean exit.
- Confirm `kestrel find --no-interactive` still uses the one-shot path.
- Confirm an argument-bearing `--json` invocation preserves JSON output.
- Confirm `/exit` does not add durable mission, journal, lock, or recovery mutations.
- Confirm SIGINT during an active handler preserves existing cancellation/recovery behavior.

## Open design constraints resolved

- Shell launch: bare `kestrel` only.
- Command syntax: slash commands.
- Layout: transcript plus fixed bottom prompt.
- Idle Ctrl+C: clear the current input; do not exit.
- Architecture: session controller/parser reusing existing handlers (Approach A).
