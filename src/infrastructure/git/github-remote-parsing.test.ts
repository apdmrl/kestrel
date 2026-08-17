import { describe, expect, it } from "vitest";
import { parseGitHubIdentity } from "./system-git-client.js";

describe("parseGitHubIdentity", () => {
  it.each([
    ["https://github.com/octocat/hello-world", "octocat", "hello-world"],
    ["https://github.com/octocat/hello-world.git", "octocat", "hello-world"],
    ["git@github.com:octocat/hello-world.git", "octocat", "hello-world"],
    ["git@github.com:octocat/hello-world", "octocat", "hello-world"],
    ["ssh://git@github.com/octocat/hello-world.git", "octocat", "hello-world"],
  ])("accepts the supported remote %s", (remote, owner, name) => {
    expect(parseGitHubIdentity(remote)).toEqual({ provider: "github", owner, name });
  });

  it.each([
    ["https://evilgithub.com/octocat/hello-world", "evilgithub.com"],
    ["https://github.com.evil.example/octocat/hello-world", "github.com.evil.example"],
    ["https://user:pass@github.com/octocat/hello-world", "credentials"],
    ["https://github.com:8080/octocat/hello-world", "port"],
    ["https://github.com/octocat", "missing name"],
    ["https://github.com/octocat/hello-world/extra", "extra path"],
    ["https://github.com/octocat/hello-world?ref=main", "query"],
    ["https://github.com/octocat/hello-world#frag", "fragment"],
    ["https://github.com/octocat%2fevil/hello-world", "encoded path"],
    ["https://github.com.evil%2eexample.com/octocat/hello-world", "encoded hostname"],
    ["http://github.com/octocat/hello-world", "http"],
    ["ssh://git@github.com:2222/octocat/hello-world", "ssh port"],
    ["https://github.com/octocat/.git", "missing owner"],
  ])("rejects the unsupported remote %s (%s)", (remote) => {
    expect(() => parseGitHubIdentity(remote)).toThrow();
  });
});
