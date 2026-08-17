/** Heuristic test-file detection used by the Bug Fix and Testing policies. */
export function isTestFile(path: string): boolean {
  const p = path.replace(/\\/g, "/").toLowerCase();
  if (/\.(test|spec)\.[a-z0-9]+$/.test(p)) {
    return true;
  }
  if (/(^|\/)(test|tests|spec|specs|__tests__)(\/|$)/.test(p)) {
    return true;
  }
  return /(^|\/)(test|spec)[_-]/.test(p);
}

/** Heuristic documentation-file detection used by the Documentation policy. */
export function isDocumentationFile(path: string): boolean {
  const p = path.replace(/\\/g, "/").toLowerCase();
  if (/\.(md|markdown|rst|adoc|txt)$/.test(p)) {
    return true;
  }
  if (/(^|\/)(docs?|documentation)(\/|$)/.test(p)) {
    return true;
  }
  return /(^|\/)(readme|changelog|contributing|license|code_of_conduct)(\.|$)/.test(p);
}
