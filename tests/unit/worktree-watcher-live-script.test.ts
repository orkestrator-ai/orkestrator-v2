import { describe, expect, test } from "bun:test";
import { percentile, summariseBurst } from "../../scripts/worktree-watcher-live";

describe("worktree-watcher-live summaries", () => {
  test("percentile is nearest-rank and null for no samples", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([30, 10, 20], 0.5)).toBe(20);
    expect(
      percentile(
        Array.from({ length: 20 }, (_, index) => index + 1),
        0.95,
      ),
    ).toBe(19);
    expect(percentile([5], 0.95)).toBe(5);
  });

  test("a burst whose last hint follows its last write is covered", () => {
    const result = summariseBurst(5_000, 1_000, 1_200, [
      { at: 1_100, hint: { fileList: true, tree: true, overflow: true } },
      {
        at: 1_650,
        hint: { fileList: true, tree: false, overflow: false, paths: ["a.txt"] },
      },
    ]);
    expect(result).toEqual({
      files: 5_000,
      writeMs: 200,
      hints: 2,
      overflowHints: 1,
      hintsWithPaths: 1,
      lastHintAfterLastWriteMs: 450,
      finalCovered: true,
    });
  });

  test("a burst whose hints all came before its last write is not covered", () => {
    const early = summariseBurst(10, 0, 500, [
      { at: 100, hint: { fileList: true, tree: false, overflow: false } },
    ]);
    expect(early.finalCovered).toBe(false);
    expect(early.lastHintAfterLastWriteMs).toBe(-400);
    const none = summariseBurst(10, 0, 500, []);
    expect(none.finalCovered).toBe(false);
    expect(none.lastHintAfterLastWriteMs).toBe(-1);
  });
});
