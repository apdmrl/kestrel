import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyLayer, evaluateRelativeImport, scan, toPosix } from "./check-boundaries.mjs";

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

describe("path-style portability", () => {
  it("normalizes Windows backslash paths to POSIX", () => {
    expect(toPosix("cli\\main.ts")).toBe("cli/main.ts");
    expect(toPosix("cli/main.ts")).toBe("cli/main.ts");
    expect(toPosix("domain\\recommendation\\engine.ts")).toBe("domain/recommendation/engine.ts");
  });

  it("classifies layers identically for POSIX and Windows paths", () => {
    const posix = [
      "cli/main.ts",
      "cli/create-program.ts",
      "bootstrap/index.ts",
      "domain/shared/identifiers.ts",
      "application/jobs/job.ts",
      "ports/repository.ts",
      "infrastructure/adapter.ts",
    ];
    for (const path of posix) {
      const windows = path.split("/").join("\\");
      expect(classifyLayer(windows)).toBe(classifyLayer(path));
      expect(classifyLayer(path)).not.toBeNull();
    }
  });

  it("recognizes the composition-root exception under both slash styles", () => {
    const posix = evaluateRelativeImport(
      "cli/main.ts",
      "bootstrap/index.js",
      "../bootstrap/index.js",
    );
    const windows = evaluateRelativeImport(
      "cli\\main.ts",
      "bootstrap\\index.js",
      "../bootstrap/index.js",
    );
    expect(posix).toBeNull();
    expect(windows).toBeNull();
  });

  it("still rejects CLI-to-bootstrap imports from any other CLI file", () => {
    const posix = evaluateRelativeImport(
      "cli/create-program.ts",
      "bootstrap/index.js",
      "../bootstrap/index.js",
    );
    const windows = evaluateRelativeImport(
      "cli\\create-program.ts",
      "bootstrap\\index.js",
      "../bootstrap/index.js",
    );
    expect(posix).not.toBeNull();
    expect(windows).not.toBeNull();
    expect(posix?.rule).toContain('may not import layer "bootstrap"');
    expect(windows?.rule).toBe(posix?.rule);
    expect(windows?.file).toBe(posix?.file);
  });

  it("yields identical decisions and diagnostics for both path representations", () => {
    const cases = [
      { from: "cli/main.ts", target: "bootstrap/index.js" },
      { from: "cli/command.ts", target: "bootstrap/index.js" },
      { from: "application/jobs/job.ts", target: "domain/shared/id.ts" },
      { from: "application/jobs/job.ts", target: "cli/command.ts" },
      { from: "domain/shared/id.ts", target: "domain/shared/id.ts" },
      { from: "infrastructure/adapter.ts", target: "application/jobs/job.ts" },
    ];
    for (const c of cases) {
      const posix = evaluateRelativeImport(c.from, c.target, "../x.js");
      const windows = evaluateRelativeImport(
        c.from.split("/").join("\\"),
        c.target.split("/").join("\\"),
        "../x.js",
      );
      expect(windows).toEqual(posix);
    }
  });
});
