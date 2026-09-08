# Kestrel

Kestrel is a local-first terminal companion for developers who want to improve by solving real open-source engineering problems. It discovers a real GitHub challenge, prepares a safe mission workspace, generates deterministic guidance for your AI coding agent, preserves engineering evidence, and records your journey — without reducing ability to artificial scores.

Kestrel prepares the work. The developer owns the work.

## Commands

```
kestrel auth login                # connect to GitHub (opens your browser)
kestrel auth status               # show which GitHub account is connected
kestrel auth logout --confirm github.com  # clear the stored GitHub credential
kestrel find                      # discover one recommended challenge
kestrel mission accept --id <id>  # accept the exact recommendation shown by find
kestrel mission prepare           # prepare the mission workspace (resumable)
kestrel mission resume            # resume an interrupted preparation
kestrel mission current           # show the current mission
kestrel mission complete          # complete the mission with local evidence
kestrel mission break-lock --id <id>  # recover a stale lock left by a crashed process
kestrel mission abandon           # abandon the mission
kestrel agent brief               # record an immutable agent brief handoff
kestrel verify submission         # verify a submitted pull request
kestrel verify link               # verify an issue link for a pull request
kestrel verify merge              # verify a merged pull request
kestrel journey                   # show the engineering journey
kestrel progress                  # show journey progress counts
kestrel preferences get           # show preferences
kestrel preferences set           # update preferences
kestrel --json journey            # machine-readable output
kestrel --plain find              # plain output
kestrel --no-interactive find     # disable interactive prompts
kestrel --no-browser auth login   # authenticate without opening a browser
```

## Connecting to GitHub

Kestrel renders the interactive session immediately and checks GitHub status for up to five seconds. It never starts login automatically. If GitHub is required, select Auth, choose `/auth login`, then press Enter again to start the device flow. Local Mission, Agent, progress, journey, and preference commands remain available while disconnected or offline; Find and Verify require an authenticated GitHub session and stay disabled until you sign in.

GitHub login works without configuration: Kestrel uses its production OAuth client ID by default. To use your own GitHub OAuth app, set `GITHUB_CLIENT_ID` to a non-empty value; leading and trailing whitespace is ignored, and an empty value uses Kestrel's default.

One-shot forms (`kestrel auth login`, `kestrel auth status`) are unchanged.

In the interactive shell:

1. Pick a category from the sidebar (for example `Auth`).
2. Pick a contextual action from the prompt (for example `/auth login`).
3. Press Enter once to fill the prompt with the action.
4. Press Enter again to execute it.

The second Enter is the explicit confirmation; nothing runs until you press it. Only an in-flight device authorization cannot resume after restart; a completed login credential, once stored through your configured Git credential helper, is reused on the next session without re-authenticating.

Command output stays in a bounded in-memory history. Use `PageUp` and `PageDown` to
move through contiguous transcript pages, `End` to return to the newest output, and
`/clear` to discard the visual history. Starting a new command returns the view to
the newest page. The current mission card is hydrated from durable mission state and
updates immediately after mission commands.

`auth logout` clears the shared `github.com` credential that `git` and `gh` also use, so it
requires `--confirm github.com`.

## What Kestrel will not change

Kestrel clones the upstream repository only. It never forks, pushes a branch, opens a pull request, installs repository dependencies, or runs repository builds/tests. Kestrel metadata is stored in a sidecar directory next to the clone, never inside the cloned repository. See `docs/security.md` for the full safety boundaries.

## Documentation

- [Architecture](docs/architecture.md)
- [State and recovery](docs/state-and-recovery.md)
- [Security](docs/security.md)
- [Troubleshooting](docs/troubleshooting.md)
