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
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const LAYERS = ["domain", "application", "ports", "infrastructure", "cli", "bootstrap"];

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
  const rel = relative(root, filePath);
  if (rel === "" || rel.startsWith("..") || rel.includes(".." + sep)) {
    return null;
  }
  const first = rel.split(sep)[0];
  return LAYERS.includes(first) ? first : null;
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
    const layer = layerOf(file, absRoot);
    if (layer === null) {
      continue;
    }
    const allowed = ALLOWED_TARGETS[layer];
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const specifier of extractSpecifiers(source)) {
      if (specifier.startsWith(".")) {
        const target = resolveTargetLayer(specifier, file, absRoot);
        if (target !== null && target !== layer && !allowed.has(target)) {
          violations.push({
            file: relative(absRoot, file),
            specifier,
            rule: 'layer "' + layer + '" may not import layer "' + target + '"',
          });
        }
      } else if (layer === "domain" && isDomainBanned(specifier)) {
        violations.push({
          file: relative(absRoot, file),
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
