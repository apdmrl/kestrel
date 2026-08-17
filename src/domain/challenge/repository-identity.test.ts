import { describe, expect, it } from "vitest";
import { createRepositoryIdentity } from "./repository-identity.js";

describe("RepositoryIdentity", () => {
  it("normalizes GitHub owner and name to lowercase", () => {
    const result = createRepositoryIdentity({ owner: "MyOrg", name: "MyRepo" });
    expect(result).toEqual({
      ok: true,
      value: { provider: "github", owner: "myorg", name: "myrepo" },
    });
  });

  it("defaults the provider to github", () => {
    const result = createRepositoryIdentity({ owner: "a", name: "b" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.provider).toBe("github");
    }
  });

  it.each([
    { owner: "", name: "repo" },
    { owner: "   ", name: "repo" },
    { owner: "org", name: "" },
    { owner: "org", name: "  " },
    { owner: "", name: "" },
  ])("rejects blank repository components (%o)", (input) => {
    const result = createRepositoryIdentity(input);
    expect(result.ok).toBe(false);
  });

  it("rejects a non-github provider", () => {
    const result = createRepositoryIdentity({
      provider: "gitlab",
      owner: "org",
      name: "repo",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toContain("PROVIDER");
    }
  });
});
