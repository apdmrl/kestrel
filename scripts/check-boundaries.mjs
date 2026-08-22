// Deterministic import-boundary scanner for Kestrel's layered architecture.
//
// Enforces two rules:
//   1. A file inside a layer may only import other layers listed in ALLOWED_TARGETS.
//   2. A file inside the domain layer may not import Node builtins or any banned
//      package (Octokit, Ink, React, Commander, Execa, Zod, chalk, credential libs).
//
// Test files (*.test.* / *.spec.*) are excluded: they are specs, not production
// module code, and legitimately import the test runner and temporary tooling.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LAYERS = ["domain", "application", "ports", "infrastructure", "cli", "bootstrap"];

// The process entry point composes the application; it may import any layer.
const ENTRY_POINT_FILES = new Set(["cli/main.ts"]);

const ALLOWED_TARGETS = {
  domain: new Set(["domain"]),
  ports: new Set(["domain", "ports"]),
  application: new Set(["domain", "ports"]),
  infrastructure: new Set(["domain", "ports", "application"]),
  cli: new Set(["application", "cli"]),
  bootstrap: new Set(LAYERS),
};

// Packages that the domain must never import.
const DOMAIN_BANNED = [
  /^node:/,
  /^octokit($|\/)/,
  /^@octokit\//,
  /^ink($|\/)/,
  /^react($|[/-])/,
  /^react-dom($|\/)/,
  /^react-reconciler($|\/)/,
  /^commander($|\/)/,
  /^execa($|\/)/,
  /^zod($|\/)/,
  /^chalk($|\/)/,
  /^keytar($|\/)/,
  /^osx-keychain($|\/)/,
  /^keychain($|\/)/,
];

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

/**
 * Normalize a repository-relative path to a single POSIX-style representation.
 *
 * Windows reports native paths with backslash separators (e.g. `cli\main.ts`)
 * while allowlists, exceptions, and fixtures use forward slashes (e.g.
 * `cli/main.ts`). Every repo-relative source/import path must be normalized
 * here before layer classification, allowlist/exception checks, equality and
 * prefix comparisons, and diagnostics so decisions are identical on every OS.
 */
export function toPosix(path) {
  return path.split("\\").join("/");
}

/** Classify a repository-relative path (either slash style) into a layer name. */
export function classifyLayer(rel) {
  const normalized = toPosix(rel);
  if (normalized === "" || normalized.startsWith("..") || normalized.includes("../")) {
    return null;
  }
  const first = normalized.split("/")[0];
  return LAYERS.includes(first) ? first : null;
}

/**
 * Decide whether a relative import is a boundary violation, independent of the
 * filesystem. Both paths are repository-relative and may use either slash
 * style; they are normalized before any comparison. Returns a violation object
 * or null.
 */
export function evaluateRelativeImport(fromRel, targetRel, specifier) {
  const from = toPosix(fromRel);
  const target = toPosix(targetRel);
  if (ENTRY_POINT_FILES.has(from)) {
    return null;
  }
  const layer = classifyLayer(from);
  if (layer === null) {
    return null;
  }
  const targetLayer = classifyLayer(target);
  if (targetLayer === null || targetLayer === layer) {
    return null;
  }
  if (ALLOWED_TARGETS[layer].has(targetLayer)) {
    return null;
  }
  return {
    file: from,
    specifier,
    rule: 'layer "' + layer + '" may not import layer "' + targetLayer + '"',
  };
}

function isTestFile(filePath) {
  return /\.(test|spec)\.(ts|tsx|mts|cts|js|mjs)$/.test(filePath);
}

function isTypeScriptFile(filePath) {
  for (const ext of TS_EXTENSIONS) {
    if (filePath.endsWith(ext)) {
      return true;
    }
  }
  return false;
}

/** Recursively list TypeScript files under root, skipping test files. */
export function listSourceFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (entry === "node_modules" || entry === "dist" || entry === ".git") {
          continue;
        }
        stack.push(full);
      } else if (isTypeScriptFile(full) && !isTestFile(full)) {
        files.push(full);
      }
    }
  }
  return files.sort();
}

/** Return the layer name for a file, or null when the file is not inside a layer. */
export function layerOf(filePath, root) {
  return classifyLayer(toPosix(relative(root, filePath)));
}

/** Resolve a relative import specifier to the target layer, or null. */
export function resolveTargetLayer(specifier, fromFile, root) {
  const abs = resolve(dirname(fromFile), specifier);
  return layerOf(abs, root);
}

/** Extract static import, re-export, and dynamic import() specifiers from source. */
export function extractSpecifiers(source) {
  const specifiers = new Set();
  const patterns = [
    /\bimport\s+[^;"']*?\bfrom\s*['"]([^'"]+)['"]/gs,
    /\bimport\s*['"]([^'"]+)['"]/gs,
    /\bexport\s+[^;"']*?\bfrom\s*['"]([^'"]+)['"]/gs,
    /\bimport\s*\(\s*['"]([^'"]+)['"]/gs,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      specifiers.add(match[1]);
    }
  }
  return [...specifiers];
}

function isDomainBanned(specifier) {
  return DOMAIN_BANNED.some((pattern) => pattern.test(specifier));
}

/**
 * Scan a root directory (e.g. src/) and return a list of boundary violations.
 * Each violation is { file, specifier, rule } where file is relative to root.
 */
export function scan(root) {
  const absRoot = resolve(root);
  const violations = [];
  for (const file of listSourceFiles(absRoot)) {
    const rel = toPosix(relative(absRoot, file));
    const layer = classifyLayer(rel);
    if (layer === null) {
      continue;
    }
    if (ENTRY_POINT_FILES.has(rel)) {
      continue;
    }
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const specifier of extractSpecifiers(source)) {
      if (specifier.startsWith(".")) {
        const abs = resolve(dirname(file), specifier);
        const targetRel = toPosix(relative(absRoot, abs));
        const violation = evaluateRelativeImport(rel, targetRel, specifier);
        if (violation !== null) {
          violations.push(violation);
        }
      } else if (layer === "domain" && isDomainBanned(specifier)) {
        violations.push({
          file: rel,
          specifier,
          rule: 'layer "domain" may not import "' + specifier + '"',
        });
      }
    }
  }
  return violations;
}

function isMainModule() {
  return (
    typeof process !== "undefined" &&
    process.argv[1] !== undefined &&
    fileURLToPath(import.meta.url) === resolve(process.argv[1])
  );
}

if (isMainModule()) {
  const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const violations = scan(root);
  if (violations.length > 0) {
    for (const violation of violations) {
      process.stderr.write(
        violation.file + ': imports "' + violation.specifier + '" — ' + violation.rule + "\n",
      );
    }
    process.stderr.write("\n" + violations.length + " boundary violation(s) found.\n");
    process.exit(1);
  }
  process.exit(0);
}
