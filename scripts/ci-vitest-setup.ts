const isCI = process.env.GITHUB_ACTIONS === "true";

if (isCI) {
  process.on("uncaughtException", (error) => {
    console.error("\n[kestrel-ci] uncaughtException:\n" + sanitize(error));
    // Preserve a non-zero exit so the failing test step still fails.
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    console.error("\n[kestrel-ci] unhandledRejection:\n" + sanitize(reason));
    process.exit(1);
  });
}

function sanitize(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}\n${value.stack ?? ""}`;
  }
  return String(value);
}
