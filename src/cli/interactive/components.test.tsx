import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { MoodPicker } from "./mood-picker.js";
import { PreparationStatus } from "./preparation-status.js";
import { ReflectionPrompt } from "./reflection-prompt.js";

describe("interactive components", () => {
  // Ink instances must be unmounted between tests; otherwise React reports
  // stale error-boundary teardown messages on stderr.
  afterEach(() => {
    cleanup();
  });

  it("renders the five fixed moods", () => {
    const { lastFrame } = render(<MoodPicker onSelect={() => undefined} />);
    expect(lastFrame()).toContain("Quick win");
    expect(lastFrame()).toContain("Surprise me");
  });

  it("renders preparation progress", () => {
    const { lastFrame } = render(<PreparationStatus completed={3} total={7} />);
    expect(lastFrame()).toContain("3/7");
  });

  it("defaults reflection to an optional Skip", () => {
    const { lastFrame } = render(
      <ReflectionPrompt onSkip={() => undefined} onSubmit={() => undefined} />,
    );
    expect(lastFrame()).toContain("Skip");
  });
});
