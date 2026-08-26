# Troubleshooting

- **"GitHub authentication is required"** — set `GITHUB_CLIENT_ID` and run `kestrel auth login` to complete the device flow, or verify your Git Credential Manager.
- **Not sure whether you are connected** — run `kestrel auth status`. It validates the stored token against GitHub and reports the live login, `Not connected`, or an expired credential. It never deletes a credential.
- **The browser did not open** — the verification URL and code are always printed, so open the URL yourself. Kestrel refuses to open anything that is not an `https:` URL with a real host and no embedded credentials. Suppress the launch with `--no-browser`, `KESTREL_NO_BROWSER=1`, or `--json`. On Linux the launch needs `xdg-open`; on WSL it prefers `wslview` and falls back to `xdg-open`.
- **`kestrel auth logout` refuses to run** — it clears the shared `github.com` credential that `git` and `gh` also use, so it requires `--confirm github.com`.
- **Ctrl+C during `/auth login` in the shell** — this cancels the login and closes the session. The cancellation signal is process-wide and one-shot, so a session that stayed open would fail every later command. Start a new session and run `/auth login` again.
- **Mission is locked** — wait for the other operation to finish. If the lock is stale (left by a crashed process), break it with `kestrel mission break-lock --id <missionId>`.
- **Corrupt state** — a `.corrupt-<timestamp>` backup is created automatically; restore from it or remove the corrupt file.
- **Interrupted preparation** — rerun the same command to resume; use "start over" only with an explicit confirmation token.
- **Rate limited** — wait for the reset time and retry.
