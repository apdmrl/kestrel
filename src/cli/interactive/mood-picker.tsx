import { Box, Text, useInput } from "ink";

export type MoodValue =
  "QUICK_WIN" | "DEEP_DEBUGGING" | "LEARN_SOMETHING_NEW" | "HARD_CHALLENGE" | "SURPRISE_ME";

export const MOOD_LABELS: readonly { value: MoodValue; label: string }[] = [
  { value: "QUICK_WIN", label: "Quick win" },
  { value: "DEEP_DEBUGGING", label: "Deep debugging" },
  { value: "LEARN_SOMETHING_NEW", label: "Learn something new" },
  { value: "HARD_CHALLENGE", label: "Hard challenge" },
  { value: "SURPRISE_ME", label: "Surprise me" },
];

export interface MoodPickerProps {
  readonly onSelect: (mood: MoodValue) => void;
}

export function MoodPicker({ onSelect }: MoodPickerProps) {
  useInput((input) => {
    const index = Number(input) - 1;
    const mood = MOOD_LABELS[index];
    if (mood !== undefined) {
      onSelect(mood.value);
    }
  });
  return (
    <Box flexDirection="column">
      <Text>What are you in the mood for?</Text>
      {MOOD_LABELS.map((mood, index) => (
        <Text key={mood.value}>
          {index + 1}. {mood.label}
        </Text>
      ))}
    </Box>
  );
}
