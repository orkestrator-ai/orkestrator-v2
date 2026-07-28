import { describe, expect, test } from "bun:test";
import {
  DIFF_STATS_CHANGED_EVENT,
  EMPTY_DIFF_STATS,
  FALLBACK_COMPARISON_REF,
  isEnvironmentDiffStats,
  isEnvironmentDiffStatsChange,
  isEnvironmentDiffStatsEvent,
  isEnvironmentDiffStatsRemoval,
  isEnvironmentDiffStatsSnapshot,
  resolveComparisonRef,
} from "./diff-stats";

const CREATION_COMMIT = "a".repeat(40);

function validChange() {
  return {
    environmentId: "env-1",
    comparisonRef: "main",
    computedAt: "2026-07-27T12:00:00.000Z",
    stats: { additions: 1, deletions: 2, filesChanged: 3, truncated: false },
  };
}

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
  // does not exist, and diff stats fail silently, so the badge never appears.
  test("falls back to the repository default branch when the PR base is blank", () => {
    expect(resolveComparisonRef(undefined, {
      defaultBranch: "trunk",
      prBaseBranch: "",
    })).toBe("trunk");
  });

  test.each([undefined, null])("uses the last-resort ref when config is %p", (config) => {
    expect(resolveComparisonRef(undefined, config)).toBe(FALLBACK_COMPARISON_REF);
  });

  test("uses the last-resort ref when both configured branches are blank", () => {
    expect(resolveComparisonRef(null, { defaultBranch: "", prBaseBranch: "" }))
      .toBe(FALLBACK_COMPARISON_REF);
  });

  test("treats an empty creation commit as absent", () => {
    expect(resolveComparisonRef("", { defaultBranch: "trunk", prBaseBranch: "release" }))
      .toBe("release");
  });

  test("trims refs and treats whitespace-only values as absent", () => {
    expect(resolveComparisonRef("  ", {
      defaultBranch: " trunk ",
      prBaseBranch: "\t",
    })).toBe("trunk");
    expect(resolveComparisonRef(` ${CREATION_COMMIT} `, {
      defaultBranch: "trunk",
    })).toBe(CREATION_COMMIT);
  });

  test("tolerates a config carrying neither branch field", () => {
    expect(resolveComparisonRef(undefined, {})).toBe(FALLBACK_COMPARISON_REF);
  });
});

describe("diff stats payload guards", () => {
  test("accepts a well-formed change", () => {
    expect(isEnvironmentDiffStatsChange(validChange())).toBe(true);
  });

  test("accepts the empty stats constant", () => {
    expect(isEnvironmentDiffStats(EMPTY_DIFF_STATS)).toBe(true);
  });

  test("accepts a well-formed removal event", () => {
    const removal = {
      environmentId: "env-1",
      comparisonRef: "release",
      computedAt: "2026-07-27T12:01:00.000Z",
      removed: true,
    };
    expect(isEnvironmentDiffStatsRemoval(removal)).toBe(true);
    expect(isEnvironmentDiffStatsEvent(removal)).toBe(true);
  });

  test("accepts a well-formed snapshot", () => {
    expect(isEnvironmentDiffStatsSnapshot({ entries: [validChange()] })).toBe(true);
    expect(isEnvironmentDiffStatsSnapshot({ entries: [] })).toBe(true);
  });

  // These cross a process boundary and drive the badge on their own, so a
  // malformed frame has to be rejected rather than written through.
  test.each([
    ["null", null],
    ["a string", "nope"],
    ["a number", 7],
    ["an array", []],
    ["missing environmentId", { ...validChange(), environmentId: undefined }],
    ["blank environmentId", { ...validChange(), environmentId: "  " }],
    ["numeric environmentId", { ...validChange(), environmentId: 1 }],
    ["missing comparisonRef", { ...validChange(), comparisonRef: undefined }],
    ["blank comparisonRef", { ...validChange(), comparisonRef: "\t" }],
    ["missing computedAt", { ...validChange(), computedAt: undefined }],
    ["invalid computedAt", { ...validChange(), computedAt: "now" }],
    ["missing stats", { ...validChange(), stats: undefined }],
    ["stats as a string", { ...validChange(), stats: "3" }],
    ["stringly-typed additions", { ...validChange(), stats: { additions: "1", deletions: 2, filesChanged: 3, truncated: false } }],
    ["missing truncated", { ...validChange(), stats: { additions: 1, deletions: 2, filesChanged: 3 } }],
    ["truncated as a string", { ...validChange(), stats: { additions: 1, deletions: 2, filesChanged: 3, truncated: "yes" } }],
    ["negative additions", { ...validChange(), stats: { additions: -1, deletions: 2, filesChanged: 3, truncated: false } }],
    ["fractional deletions", { ...validChange(), stats: { additions: 1, deletions: 0.5, filesChanged: 3, truncated: false } }],
    ["NaN filesChanged", { ...validChange(), stats: { additions: 1, deletions: 2, filesChanged: Number.NaN, truncated: false } }],
    ["infinite additions", { ...validChange(), stats: { additions: Number.POSITIVE_INFINITY, deletions: 2, filesChanged: 3, truncated: false } }],
    ["unsafe additions", { ...validChange(), stats: { additions: Number.MAX_SAFE_INTEGER + 1, deletions: 2, filesChanged: 3, truncated: false } }],
  ])("rejects %s", (_label, payload) => {
    expect(isEnvironmentDiffStatsChange(payload)).toBe(false);
  });

  test.each([
    ["not an object", null],
    ["removed is false", { environmentId: "env-1", comparisonRef: "main", computedAt: "2026-07-27T12:00:00.000Z", removed: false }],
    ["missing id", { comparisonRef: "main", computedAt: "2026-07-27T12:00:00.000Z", removed: true }],
    ["blank ref", { environmentId: "env-1", comparisonRef: " ", computedAt: "2026-07-27T12:00:00.000Z", removed: true }],
    ["invalid timestamp", { environmentId: "env-1", comparisonRef: "main", computedAt: "today", removed: true }],
  ])("rejects malformed removal: %s", (_label, payload) => {
    expect(isEnvironmentDiffStatsRemoval(payload)).toBe(false);
    expect(isEnvironmentDiffStatsEvent(payload)).toBe(false);
  });

  test.each([
    ["not an object", null],
    ["missing entries", {}],
    ["entries is not an array", { entries: "nope" }],
    ["contains malformed entry", { entries: [validChange(), { ...validChange(), environmentId: "" }] }],
    ["contains removal entry", { entries: [{ environmentId: "env-1", comparisonRef: "main", computedAt: "2026-07-27T12:00:00.000Z", removed: true }] }],
  ])("rejects malformed snapshot: %s", (_label, payload) => {
    expect(isEnvironmentDiffStatsSnapshot(payload)).toBe(false);
  });

  test("the event name is stable", () => {
    // Renaming this silently detaches every client from the backend.
    expect(DIFF_STATS_CHANGED_EVENT).toBe("environment-diff-stats-changed");
  });
});
