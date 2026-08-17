import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createKestrelError } from "../../application/errors/kestrel-error.js";
import type { AgentHandoff } from "../../domain/agent/agent-handoff.js";
import type { AgentHandoffStore } from "../../ports/agent-handoff-store.js";

export class FileSystemAgentHandoffStore implements AgentHandoffStore {
  async save(handoff: AgentHandoff, sidecarPath: string): Promise<void> {
    const directory = join(sidecarPath, "handoffs");
    await mkdir(directory, { recursive: true });
    const path = join(directory, handoff.handoffId + ".json");
    const tempPath = path + "." + randomUUID() + ".tmp";
    let handle;
    try {
      handle = await open(tempPath, "w");
      await handle.writeFile(JSON.stringify(handoff, null, 2) + "\n", "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(tempPath, path);
    } catch (error) {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      await unlink(tempPath).catch(() => undefined);
      throw createKestrelError({
        code: "DM_STATE_WRITE_FAILED",
        category: "TRANSIENT",
        userMessage: "Failed to persist the agent handoff",
        suggestedActions: ["Retry the operation"],
        retryability: "RETRYABLE",
        recoveryStrategy: "RETRY",
        severity: "ERROR",
        cause: error,
      });
    }
  }
}
