import { Box, Text, useInput } from "ink";

export interface RecommendationViewProps {
  readonly title: string;
  readonly confidence: number;
  readonly onAccept: () => void;
  readonly onShowAnother: () => void;
  readonly onBrowse: () => void;
}

export function RecommendationView(props: RecommendationViewProps) {
  useInput((input) => {
    if (input === "a") {
      props.onAccept();
    } else if (input === "s") {
      props.onShowAnother();
    } else if (input === "b") {
      props.onBrowse();
    }
  });
  return (
    <Box flexDirection="column">
      <Text>Picked for you</Text>
      <Text>{props.title}</Text>
      <Text>Confidence: {props.confidence.toFixed(2)}</Text>
      <Text>a) Accept mission</Text>
      <Text>s) Show another</Text>
      <Text>b) Browse alternatives</Text>
    </Box>
  );
}
