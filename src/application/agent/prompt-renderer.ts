import type { AgentBrief } from "../../domain/agent/agent-brief.js";

export interface PromptRenderer {
  render(brief: AgentBrief): string;
}
