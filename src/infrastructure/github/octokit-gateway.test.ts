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
});
