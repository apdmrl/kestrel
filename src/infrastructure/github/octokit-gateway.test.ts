import { describe, expect, it } from "vitest";
import type { OctokitLike, DeviceAuthFactory } from "./octokit-gateway.js";
import { OctokitGateway } from "./octokit-gateway.js";

class FakeOctokit implements OctokitLike {
  viewerResponse: { login: string; id: number } = { login: "octocat", id: 1 };
  viewerError: unknown | undefined;

  async request(
    route: string,
  ): Promise<{ status: number; data: unknown; headers: Record<string, string> }> {
    if (route === "GET /user") {
      if (this.viewerError !== undefined) {
        throw this.viewerError;
      }
      return { status: 200, data: this.viewerResponse, headers: {} };
    }
    throw new Error("unexpected route " + route);
  }
}

function fakeDeviceAuthFactory(): {
  factory: DeviceAuthFactory;
  resolveToken: (token: string) => void;
  rejectToken: (error: unknown) => void;
  verificationCalls: unknown[];
} {
  const verificationCalls: unknown[] = [];
  const tokenHandlers: { resolve: (t: string) => void; reject: (e: unknown) => void }[] = [];

  const factory: DeviceAuthFactory = (options) => {
    options.onVerification({
      device_code: "device-code",
      user_code: "ABCD",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 5,
    });
    verificationCalls.push(options);
    return () =>
      new Promise<{ token: string }>((resolve, reject) => {
        tokenHandlers.push({
          resolve: (token: string) => resolve({ token }),
          reject: (error: unknown) => reject(error),
        });
      });
  };

  return {
    factory,
    verificationCalls,
    resolveToken: (token) => tokenHandlers[0]?.resolve(token),
    rejectToken: (error) => tokenHandlers[0]?.reject(error),
  };
}

/**
 * Run `body` while capturing process-level unhandled rejections, so a detached
 * device-flow failure that would crash the CLI is observable as test data.
 */
async function withoutUnhandledRejections(body: () => Promise<void>): Promise<unknown[]> {
  const rejections: unknown[] = [];
  const onUnhandled = (error: unknown): void => {
    rejections.push(error);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    await body();
    // Node reports unhandled rejections only after the microtask queue drains.
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  return rejections;
}

describe("OctokitGateway", () => {
  it("returns the viewer identity", async () => {
    const gateway = new OctokitGateway(
      new FakeOctokit(),
      "client-id",
      fakeDeviceAuthFactory().factory,
    );
    const viewer = await gateway.getViewer("token");
    expect(viewer).toEqual({ login: "octocat", id: 1 });
  });

  it("maps a viewer auth failure", async () => {
    const octokit = new FakeOctokit();
    octokit.viewerError = { name: "HttpError", status: 401, response: { headers: {} } };
    const gateway = new OctokitGateway(octokit, "client-id", fakeDeviceAuthFactory().factory);
    await expect(gateway.getViewer("token")).rejects.toMatchObject({
      code: "DM_GITHUB_AUTH_EXPIRED",
    });
  });

  it("starts the device flow and returns a token after polling", async () => {
    const { factory, resolveToken } = fakeDeviceAuthFactory();
    const gateway = new OctokitGateway(new FakeOctokit(), "client-id", factory);

    const authorization = await gateway.beginDeviceFlow();
    expect(authorization.deviceCode).toBe("device-code");
    expect(authorization.userCode).toBe("ABCD");

    const poll = gateway.pollForToken("device-code");
    resolveToken("secret-token");
    const token = await poll;
    expect(token).toEqual({ token: "secret-token", account: "octocat" });
  });

  it("maps a device-flow failure", async () => {
    const { factory, rejectToken } = fakeDeviceAuthFactory();
    const gateway = new OctokitGateway(new FakeOctokit(), "client-id", factory);
    await gateway.beginDeviceFlow();
    const poll = gateway.pollForToken("device-code");
    rejectToken({
      name: "HttpError",
      status: 403,
      message: "abuse detection",
      response: { headers: {} },
    });
    await expect(poll).rejects.toMatchObject({ code: "DM_GITHUB_ABUSE_LIMIT" });
  });

  it("cancels the device flow on abort", async () => {
    const { factory } = fakeDeviceAuthFactory();
    const gateway = new OctokitGateway(new FakeOctokit(), "client-id", factory);
    await gateway.beginDeviceFlow();
    const controller = new AbortController();
    controller.abort();
    await expect(gateway.pollForToken("device-code", controller.signal)).rejects.toMatchObject({
      code: "DM_GITHUB_AUTH_CANCELLED",
    });
  });

  it("aborts device-flow initialization when the signal passed to beginDeviceFlow fires", async () => {
    const { factory } = fakeDeviceAuthFactory();
    const gateway = new OctokitGateway(new FakeOctokit(), "client-id", factory);
    const controller = new AbortController();
    await gateway.beginDeviceFlow(controller.signal);
    const poll = gateway.pollForToken("device-code");
    controller.abort();
    await expect(poll).rejects.toMatchObject({ code: "DM_GITHUB_AUTH_CANCELLED" });
  });

  it("makes the device-flow request abort once the begin signal fires", async () => {
    let capturedRequest: unknown;
    const factory: DeviceAuthFactory = (options) => {
      capturedRequest = options.request;
      options.onVerification({
        device_code: "d",
        user_code: "A",
        verification_uri: "u",
        expires_in: 900,
        interval: 5,
      });
      return () => new Promise<{ token: string }>(() => undefined);
    };
    const gateway = new OctokitGateway(new FakeOctokit(), "client-id", factory);
    const controller = new AbortController();
    await gateway.beginDeviceFlow(controller.signal);
    const request = capturedRequest as (
      route: string,
      opts?: Record<string, unknown>,
    ) => Promise<unknown>;
    const poll = gateway.pollForToken("device-code");
    controller.abort();
    await expect(poll).rejects.toMatchObject({ code: "DM_GITHUB_AUTH_CANCELLED" });
    await expect(request("GET /user")).rejects.toMatchObject({
      code: "DM_GITHUB_AUTH_CANCELLED",
    });
  });

  it("rejects device flow when no client id is configured", async () => {
    const gateway = new OctokitGateway(new FakeOctokit(), "", fakeDeviceAuthFactory().factory);
    await expect(gateway.beginDeviceFlow()).rejects.toMatchObject({
      code: "DM_GITHUB_AUTH_REQUIRED",
    });
  });

  it("rejects beginDeviceFlow when device-flow initialization fails before verification", async () => {
    // GitHub rejects the device-code request (for example an OAuth client id it
    // does not recognize), so `onVerification` never runs. The caller awaits
    // `beginDeviceFlow` before it can ever reach `pollForToken`, so the failure
    // has to surface here instead of leaving the caller waiting forever.
    const factory: DeviceAuthFactory = () => async () => {
      await Promise.resolve();
      throw { name: "HttpError", status: 404, response: { headers: {} } };
    };
    const gateway = new OctokitGateway(new FakeOctokit(), "client-id", factory);
    await expect(gateway.beginDeviceFlow()).rejects.toMatchObject({
      code: "DM_GITHUB_NOT_FOUND",
    });
  });

  it("keeps the device-flow failure handled when pollForToken is never called", async () => {
    // The auth work is detached from `beginDeviceFlow`'s returned promise, so an
    // unobserved rejection would escape as a process-fatal unhandled rejection
    // and kill the CLI instead of being rendered as a classified error.
    const rejections = await withoutUnhandledRejections(async () => {
      const factory: DeviceAuthFactory = () => async () => {
        await Promise.resolve();
        throw { name: "HttpError", status: 404, response: { headers: {} } };
      };
      const gateway = new OctokitGateway(new FakeOctokit(), "client-id", factory);
      await expect(gateway.beginDeviceFlow()).rejects.toMatchObject({
        code: "DM_GITHUB_NOT_FOUND",
      });
    });
    expect(rejections).toEqual([]);
  });

  it("keeps a cancelled device flow handled when pollForToken is never called", async () => {
    // Cancelling during initialization also rejects the detached auth work, and
    // the caller unwinds through `beginDeviceFlow` without ever polling.
    const rejections = await withoutUnhandledRejections(async () => {
      const factory: DeviceAuthFactory = () => () =>
        new Promise<{ token: string }>(() => undefined);
      const gateway = new OctokitGateway(new FakeOctokit(), "client-id", factory);
      const controller = new AbortController();
      const begin = gateway.beginDeviceFlow(controller.signal);
      controller.abort();
      await expect(begin).rejects.toMatchObject({ code: "DM_GITHUB_AUTH_CANCELLED" });
    });
    expect(rejections).toEqual([]);
  });

  it("still reports the device-flow failure to a later pollForToken caller", async () => {
    // Attaching a failure handler inside `beginDeviceFlow` must not swallow the
    // error for a caller that reached `pollForToken` before the flow failed.
    const { factory, rejectToken } = fakeDeviceAuthFactory();
    const gateway = new OctokitGateway(new FakeOctokit(), "client-id", factory);
    await gateway.beginDeviceFlow();
    rejectToken({ name: "HttpError", status: 404, response: { headers: {} } });
    await expect(gateway.pollForToken("device-code")).rejects.toMatchObject({
      code: "DM_GITHUB_NOT_FOUND",
    });
  });

  it("rejects a pre-aborted beginDeviceFlow promptly without starting device work", async () => {
    let factoryCalled = false;
    const factory: DeviceAuthFactory = () => {
      factoryCalled = true;
      // Never calls onVerification: if the pre-aborted signal were not handled
      // synchronously, beginDeviceFlow would hang awaiting its verification.
      return () => new Promise<{ token: string }>(() => undefined);
    };
    const gateway = new OctokitGateway(new FakeOctokit(), "client-id", factory);
    const controller = new AbortController();
    controller.abort();
    await expect(gateway.beginDeviceFlow(controller.signal)).rejects.toMatchObject({
      code: "DM_GITHUB_AUTH_CANCELLED",
    });
    // The device-auth factory is never invoked for a pre-aborted signal.
    expect(factoryCalled).toBe(false);
  });
});
