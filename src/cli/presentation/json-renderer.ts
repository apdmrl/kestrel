import type { ViewModel } from "./view-models.js";

/** Render a view model as a versioned JSON envelope (machine data, no ANSI). */
export function renderJson(view: ViewModel): string {
  const envelope =
    view.kind === "error"
      ? {
          schemaVersion: 1,
          ok: false,
          error: {
            code: view.code,
            userMessage: view.userMessage,
            suggestedActions: view.suggestedActions,
          },
        }
      : {
          schemaVersion: 1,
          ok: true,
          data: view,
        };
  return JSON.stringify(envelope, null, 2);
}
