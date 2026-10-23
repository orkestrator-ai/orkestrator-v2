import { describe, expect, test } from "bun:test";
import {
  gitHubPullRequestKey,
  gitHubPullRequestUrl,
  isGitHubPullRequestRef,
  parseGitHubPullRequestLink,
} from "./github-pull-requests.js";

describe("parseGitHubPullRequestLink", () => {
  test.each([
    ["https://github.com/acme/repo/pull/1", "summary", 1],
    ["https://github.com/acme/repo/pull/12/", "summary", 12],
    ["https://github.com/acme/repo/pull/1/files", "code", 1],
    ["https://github.com/acme/repo/pull/1/changes", "code", 1],
    ["https://github.com/acme/repo/pull/1/files/abc123", "code", 1],
    ["https://github.com/acme/repo/pull/1/commits", "timeline", 1],
    ["https://github.com/acme/repo/pull/1/commits/abc123", "timeline", 1],
    ["https://github.com/acme/repo/pull/1/checks", "summary", 1],
    ["https://github.com/acme/repo/pull/1#issuecomment-99", "summary", 1],
    ["https://github.com/acme/repo/pull/1/files#diff-abc", "code", 1],
    ["https://www.github.com/acme/my.repo_x-1/pull/42?tab=x", "summary", 42],
    ["https://GitHub.com/acme/repo/pull/3", "summary", 3],
  ] as const)("accepts %s", (href, view, number) => {
    const parsed = parseGitHubPullRequestLink(href);
    expect(parsed).toEqual({
      owner: "acme",
      repo: href.includes("my.repo") ? "my.repo_x-1" : "repo",
      number,
      view,
    });
  });

  test.each([
    "http://github.com/acme/repo/pull/1",
    "https://gitlab.com/acme/repo/pull/1",
    "https://github.com.evil.example/acme/repo/pull/1",
    "https://gist.github.com/acme/repo/pull/1",
    "https://github.com/acme/repo/issues/1",
    "https://github.com/acme/repo/pull/0",
    "https://github.com/acme/repo/pull/01",
    "https://github.com/acme/repo/pull/abc",
    "https://github.com/acme/repo/pull/99999999999999999999",
    "https://user:pass@github.com/acme/repo/pull/1",
    "https://token@github.com/acme/repo/pull/1",
    "https://github.com/acme/repo/pull/1/files/a/b",
    "https://github.com/acme/repo/pull/1/settings",
    "https://github.com/acme/repo/pull",
    "https://github.com/acme/repo",
    "https://github.com/ac%20me/repo/pull/1",
    "not a url",
    "",
  ])("rejects %s", (href) => {
    expect(parseGitHubPullRequestLink(href)).toBeNull();
  });
});

describe("pull request refs", () => {
  test("validates owner, repo and number", () => {
    expect(isGitHubPullRequestRef({ owner: "acme", repo: "repo.js", number: 1 })).toBe(true);
    expect(isGitHubPullRequestRef({ owner: "..", repo: "repo", number: 1 })).toBe(false);
    expect(isGitHubPullRequestRef({ owner: "acme", repo: ".", number: 1 })).toBe(false);
    expect(isGitHubPullRequestRef({ owner: "acme", repo: "a/b", number: 1 })).toBe(false);
    expect(isGitHubPullRequestRef({ owner: "acme", repo: "repo", number: 0 })).toBe(false);
    expect(isGitHubPullRequestRef({ owner: "acme", repo: "repo", number: 1.5 })).toBe(false);
    expect(isGitHubPullRequestRef({ owner: "acme", repo: "repo", number: "1" })).toBe(false);
    expect(isGitHubPullRequestRef(null)).toBe(false);
  });

  test("builds a case-insensitive key and the canonical URL", () => {
    const ref = { owner: "Acme", repo: "Repo", number: 5 };
    expect(gitHubPullRequestKey(ref)).toBe("acme/repo#5");
    expect(gitHubPullRequestUrl(ref)).toBe("https://github.com/Acme/Repo/pull/5");
  });
});
