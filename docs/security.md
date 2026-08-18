# Security

- No token is written to project files, mission sidecars, logs, progress records, or JSON output.
- Credentials are stored through your Git Credential Manager or OS helper via `git credential`, never as a plaintext file.
- GitHub errors are classified and redacted; raw Octokit responses never cross the adapter boundary.
- Untrusted issue and repository text is marked as data in rendered agent briefs and cannot masquerade as instructions.
- Workspace paths are validated to stay within the configured workspace root: every pre-existing symlink/reparse component is rejected, each component's canonical path is verified after creation, and cleanup never runs through a replaced parent.
- Containment limitation: Node.js exposes no directory-handle-relative, no-follow creation primitive (no mkdirat/openat), so a _concurrent local attacker_ who replaces a parent directory in the final check-to-create window can redirect a directory creation outside the root. Kestrel detects the escape canonically, classifies it as DM_UNSAFE_PATH, and leaves the empty artifact for the operator; it does not claim race-free containment against that concurrent-local-attacker model.
- A corrupt Kestrel record never endangers the cloned repository.

Kestrel has no cloud backend, public profile, team analytics, or developer score. See `docs/architecture.md` for the full non-goal list.
