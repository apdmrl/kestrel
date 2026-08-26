# Security

- No token is written to project files, mission sidecars, logs, progress records, or JSON output.
- Credentials are stored through your Git Credential Manager or OS helper via `git credential`, never as a plaintext file.
- GitHub errors are classified and redacted; raw Octokit responses never cross the adapter boundary.
- Browser launches fail closed: only an `https:` URL with a real host and no embedded userinfo is opened. `javascript:`, `file:`, `data:`, and malformed verification URIs are refused, and a refused URI is still printed as inert text. This matters because the device-flow verification URI comes from whichever server `GITHUB_API_URL` names, and `https://github.com@evil.example/` reads as GitHub while resolving elsewhere.
- Only the verification URI is passed to the browser process. The device code and the access token are never passed to a subprocess, printed, or logged, and `auth status` reports the login only.
- The browser is launched through the argument-safe process runner, which never accepts a shell command string; Windows uses `rundll32 url.dll,FileProtocolHandler` rather than the `cmd` builtin `start`.
- `kestrel auth logout` clears the host-scoped `github.com` credential that `git` and `gh` also read. That blast radius cannot be narrowed without changing the credential key, so the command refuses without an explicit `--confirm github.com` and states the consequence.
- Untrusted issue and repository text is marked as data in rendered agent briefs and cannot masquerade as instructions.
- Workspace paths are validated to stay within the configured workspace root: every pre-existing symlink/reparse component is rejected, each component's canonical path is verified after creation, and cleanup never runs through a replaced parent.
- Containment limitation: Node.js exposes no directory-handle-relative, no-follow creation primitive (no mkdirat/openat), so a _concurrent local attacker_ who replaces a parent directory in the final check-to-create window can redirect a directory creation outside the root. Kestrel detects the escape canonically, classifies it as DM_UNSAFE_PATH, and leaves the empty artifact for the operator; it does not claim race-free containment against that concurrent-local-attacker model.
- A corrupt Kestrel record never endangers the cloned repository.
- Lock ownership uses stable kernel process identity, never filesystem or wall-clock timestamps. A mission lock records the owner's `bootId` (from `/proc/sys/kernel/random/boot_id`) and `/proc/<pid>/stat` field 22 start ticks; a live pid is authoritative only on an exact identity match, and a mismatch is treated as OS pid reuse (stale). Legacy identity-less lock records remain readable: a live pid is conservatively treated as live and an absent pid as stale. On platforms without a `/proc` interface (macOS, Windows) the probe cannot read a process identity and falls back to a signal-zero check.
- The `mission break-lock` recovery command requires `--id`, runs before journal replay, resolves the target through validated index data or a validated matching pending intent (rejecting conflicting locations), and recovers the mission and global index locks while refusing every live lock. See `docs/troubleshooting.md`.

Kestrel has no cloud backend, public profile, team analytics, or developer score. See `docs/architecture.md` for the full non-goal list.
