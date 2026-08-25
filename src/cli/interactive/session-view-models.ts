export type TranscriptEntry = {
  readonly id: number;
  readonly kind: "input" | "output" | "error" | "system";
  readonly text: string;
};
