/**
 * Decide whether the current invocation should mount the persistent Ink shell
 * or delegate to Commander. `--no-browser` and `--no-interactive` are policy
 * flags the shell may legally pass through so `/auth login` honors them; any
 * other token (including a subcommand) is delegated to Commander. `--json` is
 * never compatible with the Ink shell.
 */
export function shouldStartSession(args: readonly string[]): boolean {
  if (args.length === 0) return true;
  const rootFlag: Record<string, true> = { "--no-browser": true, "--no-interactive": true };
  return args.every((arg) => arg in rootFlag);
}
