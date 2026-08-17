# Security

- No token is written to project files, mission sidecars, logs, progress records, or JSON output.
- Credentials are stored through your Git Credential Manager or OS helper via `git credential`, never as a plaintext file.
- GitHub errors are classified and redacted; raw Octokit responses never cross the adapter boundary.
- Untrusted issue and repository text is marked as data in rendered agent briefs and cannot masquerade as instructions.
- Workspace paths are validated to stay within the configured workspace root.
- A corrupt Kestrel record never endangers the cloned repository.

Kestrel has no cloud backend, public profile, team analytics, or developer score. See `docs/architecture.md` for the full non-goal list.
