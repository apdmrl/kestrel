import type { PlatformKind } from "../platform/platform.js";
import type { BrowserLauncher } from "../../ports/browser-launcher.js";
import type { ProcessRunner } from "../../ports/process-runner.js";

/**
 * Upper bound on a launch attempt. Every command below is a dispatcher that
 * hands the URL to the desktop and exits immediately rather than being the
 * browser process itself, so the kill the runner performs on timeout cannot
 * close the user's browser.
 */
const LAUNCH_TIMEOUT_MS = 10_000;

interface LaunchCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

/**
 * Ordered launch candidates for a platform. WSL lists two because `wslview`
 * ships with wslu, which is not installed by default on every distribution.
 */
function commandsFor(platform: PlatformKind, url: string): readonly LaunchCommand[] {
  switch (platform) {
    case "darwin":
      return [{ executable: "open", args: [url] }];
    case "win32":
      // `start` is a cmd.exe builtin, so it would require a shell and would
      // mangle URLs containing `&`. rundll32 takes the URL as a plain argument.
      return [{ executable: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] }];
    case "wsl":
      return [
        { executable: "wslview", args: [url] },
        { executable: "xdg-open", args: [url] },
      ];
    case "linux":
      return [{ executable: "xdg-open", args: [url] }];
  }
}

/**
 * Whether a URL is safe to hand to a browser.
 *
 * Fails closed: only `https:` with a real host and no embedded credentials is
 * allowed. The verification URI originates from whichever server
 * `GITHUB_API_URL` names, so a hostile or misconfigured environment controls
 * this string. Refusing `javascript:`, `file:`, `data:`, and malformed input
 * keeps that input from reaching a process argument.
 *
 * Userinfo is refused for two reasons: it would leak a credential into argv and
 * the browser's history, and `https://github.com@evil.example/` reads as GitHub
 * while resolving to `evil.example`. The Git client adapter refuses userinfo in
 * remote URLs for the same reason.
 *
 * The hostname check is defense in depth. Node's URL parser already rejects an
 * `https:` URL with no host, so it is not reachable through today's parser.
 */
export function isSafeBrowserUrl(url: string): boolean {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return false;
  }
  return parsed.protocol === "https:" && parsed.hostname.length > 0;
}

/**
 * Opens URLs with the platform's URL dispatcher through the argument-safe
 * process runner, which never accepts a shell command string.
 */
export class ProcessBrowserLauncher implements BrowserLauncher {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly platform: PlatformKind,
  ) {}

  async open(url: string, signal?: AbortSignal): Promise<boolean> {
    if (!isSafeBrowserUrl(url)) {
      return false;
    }
    for (const command of commandsFor(this.platform, url)) {
      if (await this.tryLaunch(command, signal)) {
        return true;
      }
    }
    return false;
  }

  /**
   * A launch failure is never an error: the caller has already presented the
   * verification URI, so authentication remains completable by hand. Timeouts
   * and cancellations are swallowed here because the operation that follows
   * observes the same signal and still reports the cancellation.
   */
  private async tryLaunch(command: LaunchCommand, signal?: AbortSignal): Promise<boolean> {
    try {
      const result = await this.runner.run({
        executable: command.executable,
        args: command.args,
        timeoutMs: LAUNCH_TIMEOUT_MS,
        ...(signal !== undefined ? { signal } : {}),
      });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }
}
