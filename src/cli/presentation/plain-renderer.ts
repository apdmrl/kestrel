import type { ViewModel } from "./view-models.js";

function bulletList(items: readonly string[]): string {
  return items.map((item) => "- " + item).join("\n");
}

/** Render a view model as plain, ANSI-free text. */
export function renderPlain(view: ViewModel): string {
  switch (view.kind) {
    case "recommendation":
      return [
        "Recommendation: " + view.title,
        "Mood: " + view.mood,
        "Confidence: " + view.confidence.toFixed(2),
        "Reasons:",
        bulletList(view.reasons),
      ].join("\n");
    case "mission":
      return "Mission " + view.id + ": " + view.status + " - " + view.title;
    case "progress":
      return [
        "Accepted: " + view.counts.accepted,
        "Completed: " + view.counts.completed,
        "Submitted: " + view.counts.submitted,
        "Linked: " + view.counts.linked,
        "Merged: " + view.counts.merged,
        "Abandoned: " + view.counts.abandoned,
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
