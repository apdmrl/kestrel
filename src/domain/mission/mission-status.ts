export type MissionStatus = "ACCEPTED" | "PREPARING" | "IN_PROGRESS" | "COMPLETED" | "ABANDONED";

export const MISSION_STATUSES: readonly MissionStatus[] = [
  "ACCEPTED",
  "PREPARING",
  "IN_PROGRESS",
  "COMPLETED",
  "ABANDONED",
];

const TERMINAL: ReadonlySet<MissionStatus> = new Set(["COMPLETED", "ABANDONED"]);

export function isTerminal(status: MissionStatus): boolean {
  return TERMINAL.has(status);
}
