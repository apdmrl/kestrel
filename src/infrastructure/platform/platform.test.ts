import { describe, expect, it } from "vitest";
import { detectPlatform, isProcessAlive } from "./platform.js";

describe("detectPlatform", () => {
  it("detects WSL with POSIX liveness", () => {
    const descriptor = detectPlatform({ platform: "linux", isWsl: true });
    expect(descriptor.kind).toBe("wsl");
    expect(descriptor.pidLiveness).toBe("signal-zero");
    expect(descriptor.separator).toBe("/");
  });

  it("detects Windows with tasklist liveness", () => {
    const descriptor = detectPlatform({ platform: "win32" });
    expect(descriptor.kind).toBe("win32");
    expect(descriptor.pidLiveness).toBe("tasklist");
  });

  it("detects macOS and linux", () => {
    expect(detectPlatform({ platform: "darwin" }).kind).toBe("darwin");
    expect(detectPlatform({ platform: "linux" }).kind).toBe("linux");
  });
});

describe("isProcessAlive", () => {
  it("reports the current process alive on POSIX", () => {
    const descriptor = detectPlatform({ platform: "linux" });
    expect(isProcessAlive(process.pid, descriptor)).toBe(true);
  });

  it("reports an unlikely PID dead on POSIX", () => {
    const descriptor = detectPlatform({ platform: "linux" });
    expect(isProcessAlive(99999999, descriptor)).toBe(false);
  });
});
