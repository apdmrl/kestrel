import { isKestrelError } from "../application/errors/kestrel-error.js";

/** Map any error to a process exit code. */
export function errorToExitCode(error: unknown): number {
  if (!isKestrelError(error)) {
    return 1;
  }
  if (
    error.code === "DM_PROCESS_CANCELLED" ||
    error.code === "DM_GITHUB_AUTH_CANCELLED" ||
    error.code === "DM_GIT_CANCELLED"
  ) {
    return 130;
  }
  if (error.category === "INVALID_INPUT") {
    return 2;
  }
  return 1;
}
