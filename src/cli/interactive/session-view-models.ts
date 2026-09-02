/**
 * Optional semantic metadata for a transcript entry. The interactive
 * session uses metadata as the single source of truth for
 * device-authorization criticality so the bounded transcript retains
 * the latest device-flow payload (validation URI + user code) without
 * hard-coding the host into a text regex. The metadata is populated
 * only when a typed `device-authorization` view reaches the session
 * through the controller's `notify` channel; the plain / JSON
 * renderers never read it.
 */
export type TranscriptMetadata =
  | {
      readonly kind: "device-authorization";
      readonly verificationUri: string;
      readonly userCode: string;
    };

export type TranscriptEntry = {
  readonly id: number;
  readonly kind: "input" | "output" | "error" | "system";
  readonly text: string;
  /**
   * Optional semantic metadata. Only set when the entry was produced
   * from a typed `device-authorization` view, in which case the
   * `verificationUri` and `userCode` are the authoritative copy.
   * The text form (`Open <uri> and enter <code>`) is the rendered
 * presentation; metadata is what the bounded window classifier and
 * bounded renderer key off.
   */
  readonly metadata?: TranscriptMetadata;
};
