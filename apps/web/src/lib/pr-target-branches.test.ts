import { describe, expect, test } from "bun:test";
import type { ProjectGitBranch } from "@orkestrator/protocol/coordinator";
import { prTargetBranchSuggestions } from "./pr-target-branches";

const local = (name: string): ProjectGitBranch => ({
  ref: `refs/heads/${name}`,
  name,
  kind: "local",
});
const remote = (name: string, remoteName = "origin"): ProjectGitBranch => ({
  ref: `refs/remotes/${remoteName}/${name}`,
  name: `${remoteName}/${name}`,
  kind: "remote",
  remote: remoteName,
});

describe("prTargetBranchSuggestions", () => {
  test("offers remote branches without their prefix, default first", () => {
    expect(
      prTargetBranchSuggestions(
        [local("feature/x"), remote("release/2.0"), remote("main"), remote("develop")],
        "main",
      ),
    ).toEqual(["main", "develop", "release/2.0"]);
  });

  test("collapses a branch present on several remotes", () => {
    expect(prTargetBranchSuggestions([remote("main"), remote("main", "upstream")], "main")).toEqual(
      ["main"],
    );
  });

  test("falls back to local branches when nothing has been fetched", () => {
    expect(prTargetBranchSuggestions([local("main"), local("feature/x")], "develop")).toEqual([
      "develop",
      "feature/x",
      "main",
    ]);
  });
});
