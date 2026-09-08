import type { ViewModel } from "./view-models.js";

function bulletList(items: readonly string[]): string {
  return items.map((item) => "- " + item).join("\n");
}

const CHALLENGE_TYPE_LABELS: Readonly<
  Record<Extract<ViewModel, { kind: "recommendation" }>["challengeType"], string>
> = {
  BUG_FIX: "Bug fix",
  TESTING: "Testing",
  DOCUMENTATION: "Documentation",
};

function issueSummary(description: string): string {
  const paragraph = description
    .split(/\n\s*\n/u)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (paragraph === undefined) return "No description provided by the issue author.";
  return paragraph
    .replace(/^\s{0,3}#{1,6}\s+/gmu, "")
    .replace(/^\s*[-*+]\s+/gmu, "")
    .replace(/\s+/gu, " ")
    .trim();
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

function renderDeviceAuthorization(view: ViewModel & { kind: "device-authorization" }): string {
  return "Open " + view.verificationUri + " and enter the code " + view.userCode;
}

function renderAuthStatus(view: ViewModel & { kind: "auth-status" }): string {
  switch (view.detail) {
    case "CONNECTED":
      return "Connected to GitHub as " + (view.login ?? "(unknown)");
    case "EXPIRED":
      return [
        "The stored GitHub credential has expired",
        "Run 'kestrel auth login' to authenticate again",
      ].join("\n");
    case "LOGGED_OUT":
      return "Logged out of GitHub";
    case "NOT_CONNECTED":
      return ["Not connected to GitHub", "Run 'kestrel auth login' to connect"].join("\n");
  }
}

/** Render a view model as plain, ANSI-free text. */
export function renderPlain(view: ViewModel): string {
  switch (view.kind) {
    case "recommendation": {
      const details = [
        view.repository + " #" + view.issueNumber,
        CHALLENGE_TYPE_LABELS[view.challengeType],
        ...(view.language === null ? [] : [view.language]),
      ].join(" · ");
      return [
        "Recommendation: " + view.title,
        details,
        "",
        "What needs to be done",
        issueSummary(view.description),
        "",
        "Why Kestrel picked this",
        bulletList(view.reasons),
        "",
        "Mood: " + view.mood + " · Confidence: " + view.confidence.toFixed(2),
        "Recommendation ID: " + view.recommendationId,
        "Issue: " + view.issueUrl,
      ].join("\n");
    }
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
    case "device-authorization":
      return renderDeviceAuthorization(view);
    case "auth-status":
      return renderAuthStatus(view);
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
