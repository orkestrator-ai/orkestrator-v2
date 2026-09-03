import { describe, expect, test } from "bun:test";
import { getGitHubRepositoryUrl } from "./gitUrl";

describe("getGitHubRepositoryUrl", () => {
  test.each([
    ["https://github.com/acme/widgets.git", "https://github.com/acme/widgets"],
    ["git@github.com:acme/widgets.git", "https://github.com/acme/widgets"],
    ["ssh://git@github.com/acme/widgets.git", "https://github.com/acme/widgets"],
    ["https://GITHUB.com/Acme/Widgets/", "https://github.com/Acme/Widgets"],
    ["https://user:token@github.com/acme/widgets.git", "https://github.com/acme/widgets"],
  ])("converts %s to a repository page URL", (gitUrl, expected) => {
    expect(getGitHubRepositoryUrl(gitUrl)).toBe(expected);
  });

  test.each([
    "https://gitlab.com/acme/widgets.git",
    "http://github.com/acme/widgets.git",
    "git://github.com/acme/widgets.git",
    "https://github.com/acme",
    "https://github.com/acme/widgets/issues",
    "https://github.com/acme/widgets%20bad.git",
    "file:///workspace/widgets",
    "/workspace/widgets",
    "",
  ])("rejects non-GitHub or malformed remote %s", (gitUrl) => {
    expect(getGitHubRepositoryUrl(gitUrl)).toBeNull();
  });
});
