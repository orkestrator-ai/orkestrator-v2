import { describe, expect, test } from "bun:test";
import {
  parseGitHubRepositoryRemote,
  type GitHubRepositoryParseFailureReason,
} from "./github-repository";

describe("parseGitHubRepositoryRemote", () => {
  test.each([
    ["https://github.com/acme/widgets.git", { owner: "acme", name: "widgets" }],
    ["git@github.com:acme/widgets.git", { owner: "acme", name: "widgets" }],
    ["ssh://git@github.com/acme/widgets.git", { owner: "acme", name: "widgets" }],
    ["https://GITHUB.com/Acme/Widgets/", { owner: "Acme", name: "Widgets" }],
    ["https://user:token@github.com/acme/widgets.git", { owner: "acme", name: "widgets" }],
  ])("parses %s", (gitUrl, repository) => {
    expect(parseGitHubRepositoryRemote(gitUrl)).toEqual({ ok: true, repository });
  });

  const rejectionCases: ReadonlyArray<readonly [string, GitHubRepositoryParseFailureReason]> = [
    ["", "missing"],
    ["/workspace/widgets", "invalid-url"],
    ["https://gitlab.com/acme/widgets.git", "unsupported-host-or-protocol"],
    ["http://github.com/acme/widgets.git", "unsupported-host-or-protocol"],
    ["git://github.com/acme/widgets.git", "unsupported-host-or-protocol"],
    ["https://github.com/acme", "invalid-path"],
    ["https://github.com/acme/widgets/issues", "invalid-path"],
    ["https://github.com/acme/widgets%20bad.git", "invalid-url"],
  ];

  test.each(rejectionCases)("rejects %s as %s", (gitUrl, reason) => {
    expect(parseGitHubRepositoryRemote(gitUrl)).toEqual({ ok: false, reason });
  });
});
