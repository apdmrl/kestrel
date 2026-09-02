import { createKestrelError } from "../../application/errors/kestrel-error.js";
import type { Credential, CredentialStore } from "../../ports/credential-store.js";
import type { ProcessRunner } from "../../ports/process-runner.js";

function hostFor(service: string): string {
  return service + ".com";
}

/** A sentinel signal that is never aborted; used when the port entry point
 * does not accept one (e.g. `store`) but the helper-detection subprocess
 * still needs a non-null AbortSignal to satisfy the contract. */
const NEVER_ABORTED: AbortSignal = new AbortController().signal;

function parseField(stdout: string, key: string): string | undefined {
  for (const line of stdout.split("\n")) {
    if (line.startsWith(key + "=")) {
      return line.slice(key.length + 1);
    }
  }
  return undefined;
}

function helperRequiredError(): ReturnType<typeof createKestrelError> {
  return createKestrelError({
    code: "DM_GITHUB_AUTH_REQUIRED",
    category: "USER_ACTION_REQUIRED",
    userMessage: "No Git credential helper is configured",
    suggestedActions: [
      "Configure a credential helper such as Git Credential Manager (git config --global credential.helper)",
    ],
    retryability: "NO_RETRY",
    recoveryStrategy: "USER_ACTION",
    severity: "ERROR",
  });
}

/**
 * Stores GitHub credentials through the user's configured Git credential helper
 * (Git Credential Manager or an OS keychain helper), never as a plaintext file.
 */
export class GitCredentialStore implements CredentialStore {
  constructor(private readonly runner: ProcessRunner) {}

  async get(
    service: string,
    _account: string,
    signal: AbortSignal,
  ): Promise<Credential | undefined> {
    const result = await this.runner.run({
      executable: "git",
      args: ["credential", "fill"],
      signal,
      input: "protocol=https\nhost=" + hostFor(service) + "\n\n",
    });
    if (result.exitCode !== 0) {
      return undefined;
    }
    const accountField = parseField(result.stdout, "username");
    const token = parseField(result.stdout, "password");
    if (accountField === undefined || token === undefined) {
      await this.requireHelper(signal);
      return undefined;
    }
    return { service, account: accountField, token };
  }

  async store(credential: Credential): Promise<void> {
    await this.requireHelper(NEVER_ABORTED);
    await this.runner.run({
      executable: "git",
      args: ["credential", "approve"],
      input:
        "protocol=https\nhost=" +
        hostFor(credential.service) +
        "\nusername=" +
        credential.account +
        "\npassword=" +
        credential.token +
        "\n\n",
    });
  }

  async delete(service: string, account: string): Promise<void> {
    await this.runner.run({
      executable: "git",
      args: ["credential", "reject"],
      input: "protocol=https\nhost=" + hostFor(service) + "\nusername=" + account + "\n\n",
    });
  }
  private async requireHelper(signal: AbortSignal): Promise<void> {
    const result = await this.runner.run({
      executable: "git",
      args: ["config", "--get", "credential.helper"],
      signal,
    });
    if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
      throw helperRequiredError();
    }
  }
}
