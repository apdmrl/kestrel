import { result, type SignalInput } from "./shared.js";

export function evaluateGrowth(input: SignalInput) {
  const language = input.challenge.language;
  if (language === undefined) {
    return result("growth", 0.5, 0, "no language information");
  }
  const known = Object.keys(input.developer.languageAffinity).map((k) => k.toLowerCase());
  const isNew = !known.includes(language.toLowerCase());
  return isNew
    ? result("growth", 1, 1, "new language " + language)
    : result("growth", 0.2, 1, "already familiar language");
}
