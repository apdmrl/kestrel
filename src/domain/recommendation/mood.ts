export type Mood =
  "QUICK_WIN" | "DEEP_DEBUGGING" | "LEARN_SOMETHING_NEW" | "HARD_CHALLENGE" | "SURPRISE_ME";

export const MOODS: readonly Mood[] = [
  "QUICK_WIN",
  "DEEP_DEBUGGING",
  "LEARN_SOMETHING_NEW",
  "HARD_CHALLENGE",
  "SURPRISE_ME",
];

export function isMood(value: string): value is Mood {
  return (MOODS as readonly string[]).includes(value);
}
