import type { AgentHandoff } from "../domain/agent/agent-handoff.js";

/** Persists immutable agent-handoff snapshots in the mission sidecar. */
export interface AgentHandoffStore {
  save(handoff: AgentHandoff, sidecarPath: string): Promise<void>;
}
