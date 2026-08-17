export type PlatformKind = "linux" | "darwin" | "win32" | "wsl";

export interface PlatformDescriptor {
  readonly kind: PlatformKind;
  readonly separator: string;
  readonly pidLiveness: "signal-zero" | "tasklist";
  readonly credentialHelper: string;
}

export interface PlatformInfo {
  readonly platform: string;
  readonly isWsl?: boolean;
}

/** Detect the smallest set of platform capabilities the adapters need. */
export function detectPlatform(info: PlatformInfo): PlatformDescriptor {
  if (info.isWsl === true) {
    return {
      kind: "wsl",
      separator: "/",
      pidLiveness: "signal-zero",
      credentialHelper: "manager-core",
    };
  }
  if (info.platform === "win32") {
    return {
      kind: "win32",
      separator: "\\",
      pidLiveness: "tasklist",
      credentialHelper: "manager-core",
    };
  }
  if (info.platform === "darwin") {
    return {
      kind: "darwin",
      separator: "/",
      pidLiveness: "signal-zero",
      credentialHelper: "osxkeychain",
    };
  }
  return {
    kind: "linux",
    separator: "/",
    pidLiveness: "signal-zero",
    credentialHelper: "libsecret",
  };
}

/** Check whether a process is alive, honoring the platform's liveness method. */
export function isProcessAlive(pid: number, descriptor: PlatformDescriptor): boolean {
  if (descriptor.pidLiveness === "signal-zero") {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as { code?: string }).code === "EPERM";
    }
  }
  // Windows tasklist-based liveness is delegated to the platform layer at runtime.
  return pid > 0;
}
