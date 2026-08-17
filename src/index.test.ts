import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { version } from "./index.js";

function packageVersion(): string {
  const url = new URL("../package.json", import.meta.url);
  const raw = readFileSync(fileURLToPath(url), "utf8");
  return (JSON.parse(raw) as { version: string }).version;
}

describe("version", () => {
  it("equals the version declared in package.json", () => {
    expect(version()).toBe(packageVersion());
  });
});
