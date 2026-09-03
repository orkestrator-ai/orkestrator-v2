import { describe, expect, test } from "bun:test";
import { GitHubApiError, resolveGitHubRepository } from "./github.js";

describe("resolveGitHubRepository", () => {
  test.each([
    ["https://github.com/acme/widgets.git", { owner: "acme", name: "widgets" }],
    ["git@github.com:acme/widgets.git", { owner: "acme", name: "widgets" }],
    ["ssh://git@github.com/acme/widgets.git", { owner: "acme", name: "widgets" }],
  ])("uses the shared remote parser for %s", (gitUrl, repository) => {
    expect(resolveGitHubRepository(gitUrl)).toEqual(repository);
  });

  test.each([
    ["", "This project does not have a GitHub repository URL."],
    ["https://gitlab.com/acme/widgets.git", "must use a github.com HTTPS or SSH URL"],
    ["https://github.com/acme", "owner and name"],
    ["https://github.com/acme/widgets%20bad.git", "Could not resolve the GitHub repository"],
  ])("preserves the validation error for %s", (gitUrl, message) => {
    expect(() => resolveGitHubRepository(gitUrl)).toThrow(GitHubApiError);
    expect(() => resolveGitHubRepository(gitUrl)).toThrow(message);
  });
});
