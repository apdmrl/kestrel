import { result, type SignalInput } from "./shared.js";

export function evaluateLanguageMatch(input: SignalInput) {
  const language = input.challenge.language;
  if (language === undefined) {
    return result("language-match", 0.5, 0, "no language information");
  }
  const preferred = input.developer.preferredLanguages.map((l) => l.toLowerCase());
  return preferred.includes(language.toLowerCase())
    ? result("language-match", 1, 1, "matches preferred language " + language)
    : result("language-match", 0, 1, "does not match preferred languages");
}
