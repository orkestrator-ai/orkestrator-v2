import { describe, expect, test } from "bun:test";
import { isGitRemoteUrl, withoutUrlCredentials } from "./git-remote-url";

describe("isGitRemoteUrl", () => {
  test("accepts HTTPS, SSH, and scp-style remotes", () => {
    expect(isGitRemoteUrl("https://github.com/owner/repo.git")).toBe(true);
    expect(isGitRemoteUrl("http://git.example.com/owner/repo")).toBe(true);
    expect(isGitRemoteUrl("ssh://git@github.com/owner/repo.git")).toBe(true);
    expect(isGitRemoteUrl("git@github.com:owner/repo.git")).toBe(true);
  });

  test("ignores surrounding whitespace", () => {
    expect(isGitRemoteUrl("  git@github.com:owner/repo.git  ")).toBe(true);
  });

  test("rejects blank values, local paths, and bare hosts", () => {
    expect(isGitRemoteUrl("")).toBe(false);
    expect(isGitRemoteUrl("   ")).toBe(false);
    expect(isGitRemoteUrl("/Users/me/repo")).toBe(false);
    expect(isGitRemoteUrl("github.com/owner/repo")).toBe(false);
    expect(isGitRemoteUrl("https://")).toBe(false);
  });
});

describe("withoutUrlCredentials", () => {
  test("strips HTTP and SSH userinfo without changing the remote path", () => {
    expect(withoutUrlCredentials("https://user:token@github.com/owner/repo.git")).toBe(
      "https://github.com/owner/repo.git",
    );
    expect(withoutUrlCredentials("ssh://git:secret@example.com/owner/repo.git")).toBe(
      "ssh://example.com/owner/repo.git",
    );
  });

  test("leaves scp-style and local-path remotes unchanged", () => {
    expect(withoutUrlCredentials("git@github.com:owner/repo.git")).toBe(
      "git@github.com:owner/repo.git",
    );
    expect(withoutUrlCredentials("/tmp/origin.git")).toBe("/tmp/origin.git");
  });
});
