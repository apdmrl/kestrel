import type { Credential, CredentialStore } from "../../ports/credential-store.js";
import type { ProcessRunner } from "../../ports/process-runner.js";

function hostFor(service: string): string {
  return service + ".com";
}

function parseField(stdout: string, key: string): string | undefined {
  for (const line of stdout.split("\n")) {
    if (line.startsWith(key + "=")) {
      return line.slice(key.length + 1);
    }
  }
  return undefined;
}

/**
 * Stores GitHub credentials through the user's configured Git credential helper
 * (Git Credential Manager or an OS keychain helper), never as a plaintext file.
 */
export class GitCredentialStore implements CredentialStore {
  constructor(private readonly runner: ProcessRunner) {}

  async get(service: string, _account: string): Promise<Credential | undefined> {
    const result = await this.runner.run({
      executable: "git",
      args: ["credential", "fill"],
      input: "protocol=https\nhost=" + hostFor(service) + "\n\n",
    });
    if (result.exitCode !== 0) {
      return undefined;
    }
    const account = parseField(result.stdout, "username");
    const token = parseField(result.stdout, "password");
    if (account === undefined || token === undefined) {
      return undefined;
    }
    return { service, account, token };
  }

  async store(credential: Credential): Promise<void> {
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
}
