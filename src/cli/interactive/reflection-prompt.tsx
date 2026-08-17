import { Box, Text, useInput } from "ink";

export interface ReflectionPromptProps {
  readonly onSkip: () => void;
  readonly onSubmit: () => void;
}

export function ReflectionPrompt({ onSkip, onSubmit }: ReflectionPromptProps) {
  useInput((input) => {
    if (input === "y") {
      onSubmit();
    } else if (input === "s" || input === "n") {
      onSkip();
    }
  });
  return (
    <Box flexDirection="column">
      <Text>Add a quick reflection?</Text>
      <Text>y) Yes</Text>
      <Text>s) Skip</Text>
    </Box>
  );
}
