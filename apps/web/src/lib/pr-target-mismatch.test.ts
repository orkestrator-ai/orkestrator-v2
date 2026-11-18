import { describe, expect, test } from "bun:test";
import {
  configuredPrTargetBranch,
  configuredPrTargetForPullRequest,
  prTargetMismatch,
} from "./pr-target-mismatch";

describe("configuredPrTargetBranch", () => {
  test("reads the PR base branch, then the default branch, as the PR monitor does", () => {
    expect(configuredPrTargetBranch({ prBaseBranch: "develop", defaultBranch: "main" })).toBe(
      "develop",
    );
    expect(configuredPrTargetBranch({ prBaseBranch: "  ", defaultBranch: "master" })).toBe(
      "master",
    );
    expect(configuredPrTargetBranch({ prBaseBranch: "", defaultBranch: "" })).toBe("main");
  });

  test("unknown settings name no target, so nothing is flagged on a guess", () => {
    expect(configuredPrTargetBranch(undefined)).toBeNull();
    expect(configuredPrTargetBranch(null)).toBeNull();
  });
});

describe("prTargetMismatch", () => {
  test("reports the actual and configured branches when they differ", () => {
    expect(prTargetMismatch({ actualBase: "dev", configuredBase: "main" })).toEqual({
      actual: "dev",
      configured: "main",
    });
  });

  test("agreeing or unknown branches are not a mismatch", () => {
    expect(prTargetMismatch({ actualBase: "main", configuredBase: " main " })).toBeNull();
    expect(prTargetMismatch({ actualBase: null, configuredBase: "main" })).toBeNull();
    expect(prTargetMismatch({ actualBase: "dev", configuredBase: null })).toBeNull();
    expect(prTargetMismatch({ actualBase: "  ", configuredBase: "main" })).toBeNull();
  });
});

describe("configuredPrTargetForPullRequest", () => {
  const ref = { owner: "Acme", repo: "Widget" };

  test("uses the settings of the project whose GitHub remote is the PR's repository", () => {
    expect(
      configuredPrTargetForPullRequest(
        ref,
        [
          { id: "other", gitUrl: "https://github.com/acme/other.git" },
          { id: "widget", gitUrl: "git@github.com:acme/widget.git" },
        ],
        {
          other: { prBaseBranch: "release", defaultBranch: "main" },
          widget: { prBaseBranch: "develop", defaultBranch: "main" },
        },
      ),
    ).toBe("develop");
  });

  test("no tracking project, or projects that disagree, name no target", () => {
    expect(
      configuredPrTargetForPullRequest(
        ref,
        [{ id: "other", gitUrl: "https://github.com/acme/other" }],
        { other: { prBaseBranch: "main" } },
      ),
    ).toBeNull();
    expect(
      configuredPrTargetForPullRequest(
        ref,
        [
          { id: "a", gitUrl: "https://github.com/acme/widget" },
          { id: "b", gitUrl: "git@github.com:acme/widget.git" },
        ],
        { a: { prBaseBranch: "main" }, b: { prBaseBranch: "develop" } },
      ),
    ).toBeNull();
  });

  test("projects that agree name their shared target", () => {
    expect(
      configuredPrTargetForPullRequest(
        ref,
        [
          { id: "a", gitUrl: "https://github.com/acme/widget" },
          { id: "b", gitUrl: "git@github.com:acme/widget.git" },
        ],
        { a: { prBaseBranch: "main" }, b: { prBaseBranch: "main" } },
      ),
    ).toBe("main");
  });
});
