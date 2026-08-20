# Kestrel

Kestrel is a local-first terminal companion for developers who want to improve by solving real open-source engineering problems. It discovers a real GitHub challenge, prepares a safe mission workspace, generates deterministic guidance for your AI coding agent, preserves engineering evidence, and records your journey — without reducing ability to artificial scores.

Kestrel prepares the work. The developer owns the work.

## Commands

```
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
```

## What Kestrel will not change

Kestrel clones the upstream repository only. It never forks, pushes a branch, opens a pull request, installs repository dependencies, or runs repository builds/tests. Kestrel metadata is stored in a sidecar directory next to the clone, never inside the cloned repository. See `docs/security.md` for the full safety boundaries.

## Documentation

- [Architecture](docs/architecture.md)
- [State and recovery](docs/state-and-recovery.md)
- [Security](docs/security.md)
- [Troubleshooting](docs/troubleshooting.md)
