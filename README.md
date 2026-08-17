# Kestrel

Kestrel is a local-first terminal companion for developers who want to improve by solving real open-source engineering problems. It discovers a real GitHub challenge, prepares a safe mission workspace, generates deterministic guidance for your AI coding agent, preserves engineering evidence, and records your journey — without reducing ability to artificial scores.

Kestrel prepares the work. The developer owns the work.

## Commands

```
kestrel find                      # discover one recommended challenge
kestrel current                   # show the current mission
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
