import { describe, test, expect } from "bun:test";
import {
  MAX_DIFF_CACHE_ENTRIES,
  MAX_INLINE_FILE_BYTES,
  TRUNCATED_NOTICE,
  applyDiffBudget,
  describeDiffBudget,
  pruneDiffCache,
} from "./diff-budget.js";
import type { FileChangeDiffContext, ToolDiffMetadata } from "./types.js";

function context(): FileChangeDiffContext {
  return { cache: new Map() };
}

const big = "x".repeat(MAX_INLINE_FILE_BYTES + 1);

describe("oversized file contents", () => {
  /**
   * `before`/`after` are entire file contents. Two copies per changed file, per
   * thread, is the bridge's largest memory consumer — and for a huge generated
   * file nobody opens the side-by-side view anyway.
   */
  test("drops before/after past the inline limit but keeps the diff and counts", () => {
    const result = applyDiffBudget({
      filePath: "/repo/bundle.js",
      before: big,
      after: big,
      diff: "@@ -1 +1 @@",
      additions: 3,
      deletions: 2,
    });

    expect(result.before).toBeUndefined();
    expect(result.after).toBeUndefined();
    // The transcript still shows what changed and by how much.
    expect(result.diff).toBe("@@ -1 +1 @@");
    expect(result).toMatchObject({ additions: 3, deletions: 2, filePath: "/repo/bundle.js" });
  });

  test("drops redundant before/after when an ordinary file has a unified diff", () => {
    const result = applyDiffBudget({ before: "a", after: "b", diff: "d" });
    expect(result).toEqual({ before: undefined, after: undefined, diff: "d" });
  });

  test("keeps before/after as the fallback when no unified diff exists", () => {
    const result = applyDiffBudget({ before: "a", after: "b" });
    expect(result).toMatchObject({ before: "a", after: "b" });
  });

  test("truncates a pathological diff rather than storing it whole", () => {
    const result = applyDiffBudget({ diff: "y".repeat(2 * 1024 * 1024) });
    expect(result.diff!.length).toBeLessThan(2 * 1024 * 1024);
    expect(result.diff!.endsWith(TRUNCATED_NOTICE)).toBe(true);
  });

  test("a partially-kept file is never produced", () => {
    // Half a file in a side-by-side view is worse than no side-by-side view.
    const result = applyDiffBudget({ before: big, after: "small" });
    expect(result.before).toBeUndefined();
    expect(result.after).toBeUndefined();
  });
});

describe("per-turn cache", () => {
  test("caps entries within a turn", () => {
    const ctx = context();
    for (let index = 0; index < MAX_DIFF_CACHE_ENTRIES + 5; index += 1) {
      ctx.cache.set(`key-${index}`, { diff: "d" } as ToolDiffMetadata);
    }
    expect(pruneDiffCache(ctx.cache)).toBe(5);
    expect(ctx.cache.size).toBe(MAX_DIFF_CACHE_ENTRIES);
  });
});

describe("describeDiffBudget", () => {
  test("reports the cache size for health", () => {
    const ctx = context();
    ctx.cache.set("k", { diff: "d" } as ToolDiffMetadata);

    expect(describeDiffBudget(ctx)).toEqual({ cacheEntries: 1 });
  });
});
