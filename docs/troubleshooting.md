# Troubleshooting

- **"GitHub authentication is required"** — set `GITHUB_CLIENT_ID` and re-run the command to complete the device flow, or verify your Git Credential Manager.
- **Mission is locked** — wait for the other operation to finish. If the lock is stale, break it with the recovery command.
- **Corrupt state** — a `.corrupt-<timestamp>` backup is created automatically; restore from it or remove the corrupt file.
- **Interrupted preparation** — rerun the same command to resume; use "start over" only with an explicit confirmation token.
- **Rate limited** — wait for the reset time and retry.
