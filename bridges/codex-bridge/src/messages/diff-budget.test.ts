import { describe, test, expect } from "bun:test";
import {
  BaselineMap,
  MAX_BASELINE_ENTRIES,
  MAX_DIFF_CACHE_ENTRIES,
  MAX_INLINE_FILE_BYTES,
  TRUNCATED_NOTICE,
  applyDiffBudget,
  beginTurn,
  describeDiffBudget,
  isBaselineWorthKeeping,
  pruneBaselines,
  pruneDiffCache,
  touchBaseline,
} from "./diff-budget.js";
import type { FileChangeDiffContext, ToolDiffMetadata } from "./types.js";

function context(): FileChangeDiffContext {
  return { baselines: new BaselineMap(), cache: new Map() };
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

  test("isBaselineWorthKeeping gates on the same limit", () => {
    expect(isBaselineWorthKeeping("small")).toBe(true);
    expect(isBaselineWorthKeeping(big)).toBe(false);
    expect(isBaselineWorthKeeping(undefined)).toBe(true);
  });
});

describe("baseline eviction", () => {
  test("evicts oldest-first past the entry cap", () => {
    const ctx = context();
    for (let index = 0; index < MAX_BASELINE_ENTRIES + 10; index += 1) {
      ctx.baselines.set(`file-${index}.ts`, "content");
    }

    const evicted = pruneBaselines(ctx.baselines);
    expect(evicted).toBe(10);
    expect(ctx.baselines.size).toBe(MAX_BASELINE_ENTRIES);
    // The earliest entries went; a missing baseline just means the next diff for
    // that file is taken against git HEAD, which is still correct.
    expect(ctx.baselines.has("file-0.ts")).toBe(false);
    expect(ctx.baselines.has("file-137.ts")).toBe(true);
  });

  test("touchBaseline makes eviction LRU rather than FIFO", () => {
    const ctx = context();
    for (let index = 0; index < MAX_BASELINE_ENTRIES; index += 1) {
      ctx.baselines.set(`file-${index}.ts`, "content");
    }
    // A file edited repeatedly should outlive one touched once at the start.
    touchBaseline(ctx.baselines, "file-0.ts");
    ctx.baselines.set("newcomer.ts", "content");
    pruneBaselines(ctx.baselines);

    expect(ctx.baselines.has("file-0.ts")).toBe(true);
    expect(ctx.baselines.has("file-1.ts")).toBe(false);
  });

  test("touching an absent baseline is a no-op", () => {
    const ctx = context();
    touchBaseline(ctx.baselines, "missing.ts");
    expect(ctx.baselines.size).toBe(0);
  });

  test("enforces a byte budget as well as an entry count", () => {
    const ctx = context();
    // Well under the entry cap, but far over the byte budget.
    for (let index = 0; index < 40; index += 1) {
      ctx.baselines.set(`file-${index}.ts`, "z".repeat(1024 * 1024));
    }
    pruneBaselines(ctx.baselines);

    expect(describeDiffBudget(ctx).baselineBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
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

  /**
   * The legacy engine cleared the per-item cache each turn but *kept* baselines.
   * Dropping baselines would make every turn diff against git HEAD, so turn 3
   * would re-display the changes made in turns 1 and 2 as if they were new.
   */
  test("beginTurn clears the cache and preserves baselines", () => {
    const ctx = context();
    ctx.baselines.set("a.ts", "after turn 1");
    ctx.cache.set("item-1", { diff: "d" } as ToolDiffMetadata);

    beginTurn(ctx);

    expect(ctx.cache.size).toBe(0);
    expect(ctx.baselines.get("a.ts")).toBe("after turn 1");
  });

  test("beginTurn also brings baselines back inside budget", () => {
    const ctx = context();
    for (let index = 0; index < MAX_BASELINE_ENTRIES + 5; index += 1) {
      ctx.baselines.set(`file-${index}.ts`, "content");
    }
    beginTurn(ctx);
    expect(ctx.baselines.size).toBe(MAX_BASELINE_ENTRIES);
  });
});

describe("BaselineMap byte accounting", () => {
  /**
   * The running total is what makes every budget check O(1); it must stay equal
   * to what a full recount would report through every kind of mutation.
   */
  const recount = (map: BaselineMap): number => {
    let total = 0;
    for (const value of map.values()) {
      total += value === undefined ? 0 : Buffer.byteLength(value, "utf8");
    }
    return total;
  };

  test("tracks set, overwrite, delete, and clear", () => {
    const map = new BaselineMap();
    expect(map.totalBytes).toBe(0);

    map.set("a.ts", "12345");
    map.set("b.ts", "1234567890");
    expect(map.totalBytes).toBe(15);

    // Overwriting replaces the old value's bytes rather than adding to them.
    map.set("a.ts", "1");
    expect(map.totalBytes).toBe(11);

    map.delete("b.ts");
    expect(map.totalBytes).toBe(1);
    // Deleting a missing key changes nothing.
    map.delete("missing.ts");
    expect(map.totalBytes).toBe(1);

    map.clear();
    expect(map.totalBytes).toBe(0);
    expect(map.totalBytes).toBe(recount(map));
  });

  test("counts UTF-8 bytes, not string length", () => {
    const map = new BaselineMap();
    map.set("unicode.ts", "héllo");
    expect(map.totalBytes).toBe(Buffer.byteLength("héllo", "utf8"));
    expect(map.totalBytes).toBe(recount(map));
  });

  test("undefined values (deleted files) count as zero bytes", () => {
    const map = new BaselineMap();
    map.set("deleted.ts", undefined);
    map.set("kept.ts", "abc");
    map.set("kept.ts", undefined);
    expect(map.totalBytes).toBe(0);
    expect(map.totalBytes).toBe(recount(map));
  });

  test("constructor entries are counted", () => {
    const map = new BaselineMap([
      ["a.ts", "1234"],
      ["b.ts", undefined],
    ]);
    expect(map.totalBytes).toBe(4);
    expect(map.totalBytes).toBe(recount(map));
  });

  test("touchBaseline preserves the total while reordering", () => {
    const map = new BaselineMap();
    map.set("a.ts", "12345");
    map.set("b.ts", "678");
    touchBaseline(map, "a.ts");
    expect(map.totalBytes).toBe(8);
    expect([...map.keys()]).toEqual(["b.ts", "a.ts"]);
  });

  test("the total stays exact through pruning", () => {
    const map = new BaselineMap();
    for (let index = 0; index < 40; index += 1) {
      map.set(`file-${index}.ts`, "z".repeat(1024 * 1024));
    }
    pruneBaselines(map);
    expect(map.totalBytes).toBe(recount(map));
    expect(map.totalBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
  });
});

describe("describeDiffBudget", () => {
  test("reports entries and bytes for health", () => {
    const ctx = context();
    ctx.baselines.set("a.ts", "12345");
    ctx.cache.set("k", { diff: "d" } as ToolDiffMetadata);

    expect(describeDiffBudget(ctx)).toEqual({
      baselineEntries: 1,
      baselineBytes: 5,
      cacheEntries: 1,
    });
  });

  test("ignores undefined baselines when counting bytes", () => {
    const ctx = context();
    ctx.baselines.set("deleted.ts", undefined);
    expect(describeDiffBudget(ctx).baselineBytes).toBe(0);
  });
});
