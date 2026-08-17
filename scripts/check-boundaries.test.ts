import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scan } from "./check-boundaries.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures", "boundaries");

describe("boundary scanner", () => {
  it("accepts a valid import graph", () => {
    expect(scan(join(fixtures, "valid"))).toEqual([]);
  });

  it("rejects a domain file importing a Node builtin", () => {
    const violations = scan(join(fixtures, "invalid-domain-node"));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.specifier).toBe("node:fs");
    expect(violations[0]?.rule).toContain("domain");
  });

  it("rejects a domain file importing the infrastructure layer", () => {
    const violations = scan(join(fixtures, "invalid-domain-infrastructure"));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.specifier).toBe("../infrastructure/adapter.js");
  });

  it("rejects an application file importing the cli layer", () => {
    const violations = scan(join(fixtures, "invalid-application-cli"));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.specifier).toBe("../cli/command.js");
  });
});
