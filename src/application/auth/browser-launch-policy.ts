/** Every input that can suppress an automatic browser launch. */
export interface BrowserLaunchContext {
  /** The `--no-browser` flag was passed. */
  readonly noBrowserFlag: boolean;
  /** `KESTREL_NO_BROWSER` is set in the environment. */
  readonly envDisabled: boolean;
  /** `--json` was passed, so the caller expects a machine contract. */
  readonly json: boolean;
  /** Whether the session may present interactive instructions at all. */
  readonly interactive: boolean;
}

/**
 * Decide whether the device-flow verification URI may be opened in a browser.
 *
 * `--json` suppresses the launch because JSON output is the machine contract
 * and an automated caller must never have a GUI opened on its behalf. A
 * non-interactive session cannot reach the device flow today, but it is
 * encoded here so the policy is total and independently testable rather than
 * relying on a caller-side invariant.
 */
export function shouldOpenBrowser(context: BrowserLaunchContext): boolean {
  if (context.noBrowserFlag || context.envDisabled || context.json) {
    return false;
  }
  return context.interactive;
}
