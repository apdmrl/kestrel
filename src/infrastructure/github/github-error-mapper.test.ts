import { describe, expect, it } from "vitest";
import { mapGitHubError } from "./github-error-mapper.js";

describe("mapGitHubError", () => {
  it("maps a network failure", () => {
    expect(mapGitHubError({ name: "RequestError", status: undefined }).code).toBe(
      "DM_NETWORK_UNAVAILABLE",
    );
  });

  it("maps a timeout", () => {
    expect(mapGitHubError({ name: "AbortError", message: "aborted" }).code).toBe(
      "DM_GITHUB_TIMEOUT",
    );
  });

  it("maps a 401 to auth expired", () => {
    expect(mapGitHubError({ name: "HttpError", status: 401, response: { headers: {} } }).code).toBe(
      "DM_GITHUB_AUTH_EXPIRED",
    );
  });

  it("maps a 403 rate limit and exposes the reset time", () => {
    const error = mapGitHubError({
      name: "HttpError",
      status: 403,
      response: { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1234567890" } },
    });
    expect(error.code).toBe("DM_GITHUB_RATE_LIMITED");
    expect(error.debugContext).toEqual({ rateLimitReset: "1234567890" });
  });

  it("maps a 403 abuse limit", () => {
    expect(
      mapGitHubError({
        name: "HttpError",
        status: 403,
        message: "abuse detection",
        response: { headers: {} },
      }).code,
    ).toBe("DM_GITHUB_ABUSE_LIMIT");
  });

  it("maps a 404", () => {
    expect(mapGitHubError({ name: "HttpError", status: 404, response: { headers: {} } }).code).toBe(
      "DM_GITHUB_NOT_FOUND",
    );
  });

  it("maps a 422 validation failure", () => {
    expect(mapGitHubError({ name: "HttpError", status: 422, response: { headers: {} } }).code).toBe(
      "DM_GITHUB_VALIDATION",
    );
  });

  it("maps an unknown failure to fatal", () => {
    expect(mapGitHubError({ name: "HttpError", status: 500, response: { headers: {} } }).code).toBe(
      "DM_GITHUB_FATAL",
    );
  });
});
