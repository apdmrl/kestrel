import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProgram } from "../../src/cli/create-program.js";
import type { CommandHandlers } from "../../src/cli/command-handlers.js";

const root = process.cwd();

function noopHandlers(): CommandHandlers {
  const view = async () => ({
    kind: "verification" as const,
    text: "ok",
  });
  return {
    find: view,
    missionAccept: view,
    missionPrepare: view,
    missionResume: view,
    missionCurrent: view,
    missionComplete: view,
    missionAbandon: view,
    agentBrief: view,
    verifySubmission: view,
    verifyLink: view,
    verifyMerge: view,
    journey: view,
    progress: view,
    preferencesGet: view,
    preferencesSet: view,
  };
}

function extractCommands(doc: string): string[] {
  const matches = [...doc.matchAll(/\n\s*kestrel ([^\n]+)/g)];
  return matches
    .map((m) => "kestrel " + (m[1] as string).trim().split("#")[0].trim())
    .filter((c) => c.length > 0);
}

describe("documented commands", () => {
  it("every fenced kestrel example is a valid command", async () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const commands = extractCommands(readme);
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      const argv = command.split(" ").filter((part) => part !== "" && part !== "kestrel");
      const program = createProgram({
        handlers: noopHandlers(),
        stdout: () => undefined,
        stderr: () => undefined,
      });
      await expect(program.parseAsync(["node", "kestrel", ...argv])).resolves.toBeDefined();
    }
  });
});
