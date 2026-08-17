import type { ViewModel } from "./view-models.js";

function bulletList(items: readonly string[]): string {
  return items.map((item) => "- " + item).join("\n");
}

function renderMission(view: ViewModel & { kind: "mission" }): string {
  const lines = ["Mission " + view.id + ": " + view.status + " - " + view.title];
  if (view.repository !== undefined) {
    lines.push("Repository: " + view.repository);
  }
  if (view.verification !== undefined) {
    lines.push("Verification: " + view.verification);
  }
  if (view.branch !== undefined) {
    lines.push("Branch: " + view.branch);
  }
  return lines.join("\n");
}

/** Render a view model as plain, ANSI-free text. */
export function renderPlain(view: ViewModel): string {
  switch (view.kind) {
    case "recommendation":
      return [
        "Recommendation: " + view.title,
        "Recommendation ID: " + view.recommendationId,
        "Mood: " + view.mood,
        "Confidence: " + view.confidence.toFixed(2),
        "Reasons:",
        bulletList(view.reasons),
      ].join("\n");
    case "mission":
      return renderMission(view);
    case "progress":
      return [
        "Accepted: " + view.counts.accepted,
        "Completed: " + view.counts.completed,
        "Submitted: " + view.counts.submitted,
        "Linked: " + view.counts.linked,
        "Merged: " + view.counts.merged,
        "Abandoned: " + view.counts.abandoned,
      ].join("\n");
    case "journey":
      if (view.entries.length === 0) {
        return "No journey events recorded";
      }
      return view.entries
        .map((entry) => entry.occurredAt + " " + entry.type + " " + entry.missionId)
        .join("\n");
    case "preferences":
      return [
        "Preferred languages: " +
          (view.preferredLanguages.length > 0 ? view.preferredLanguages.join(", ") : "(none)"),
        "Preferred difficulty: " + (view.preferredDifficulty ?? "(none)"),
        "Default mode: " + view.defaultMode,
        "Workspace root: " + (view.workspaceRoot ?? "(default)"),
      ].join("\n");
    case "handoff":
      return "Handoff " + view.handoffId + " (prompt hash " + view.renderedPromptHash + ")";
    case "verification":
      return view.text;
    case "error":
      return (
        "Error [" +
        view.code +
        "]: " +
        view.userMessage +
        "\nActions:\n" +
        bulletList(view.suggestedActions)
      );
  }
}
