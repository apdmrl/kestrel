/**
 * Opens a URL in the user's browser.
 *
 * Implementations must never throw: a browser launch is an accelerant for the
 * device flow, never a prerequisite. Authentication stays completable by hand
 * when no browser can be opened, so a failure is reported as `false` rather
 * than as an error that would abort a recoverable flow.
 */
export interface BrowserLauncher {
  /** Attempt to open url. Resolves true when launched, false otherwise. */
  open(url: string, signal?: AbortSignal): Promise<boolean>;
}
