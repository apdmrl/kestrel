import { Box, Text } from "ink";

export interface PreparationStatusProps {
  readonly completed: number;
  readonly total: number;
}

export function PreparationStatus({ completed, total }: PreparationStatusProps) {
  return (
    <Box>
      <Text>
        Preparing mission: {completed}/{total}
      </Text>
    </Box>
  );
}
