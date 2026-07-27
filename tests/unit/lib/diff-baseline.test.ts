import { describe, expect, test } from "bun:test";
import {
  FALLBACK_COMPARISON_REF,
  resolveComparisonRef,
} from "../../../apps/web/src/lib/diff-baseline";

const CREATION_COMMIT = "a".repeat(40);

describe("resolveComparisonRef", () => {
  test("prefers the recorded creation commit over any configured branch", () => {
    expect(resolveComparisonRef(CREATION_COMMIT, {
      defaultBranch: "trunk",
      prBaseBranch: "release",
    })).toBe(CREATION_COMMIT);
  });

  test("uses the PR base branch when there is no creation commit", () => {
    expect(resolveComparisonRef(undefined, {
      defaultBranch: "trunk",
      prBaseBranch: "release",
    })).toBe("release");
  });

  // A repository on master/trunk would otherwise be measured against a ref that
  // does not exist, and diff stats fail silently, so the badge just never appears.
  test("falls back to the repository default branch when the PR base is blank", () => {
    expect(resolveComparisonRef(undefined, {
      defaultBranch: "trunk",
      prBaseBranch: "",
    })).toBe("trunk");
  });

  test("falls back to the default branch when the environment has no creation commit and no PR base", () => {
    expect(resolveComparisonRef(null, {
      defaultBranch: "master",
      prBaseBranch: "",
    })).toBe("master");
  });

  test.each([undefined, null])("uses the last-resort ref when config is %p", (config) => {
    expect(resolveComparisonRef(undefined, config)).toBe(FALLBACK_COMPARISON_REF);
  });

  test("uses the last-resort ref when both configured branches are blank", () => {
    expect(resolveComparisonRef(undefined, {
      defaultBranch: "",
      prBaseBranch: "",
    })).toBe(FALLBACK_COMPARISON_REF);
  });

  test("treats an empty creation commit as absent", () => {
    expect(resolveComparisonRef("", {
      defaultBranch: "trunk",
      prBaseBranch: "release",
    })).toBe("release");
  });
});
