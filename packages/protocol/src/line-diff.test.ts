import { describe, expect, test } from "bun:test";
import { DEFAULT_LINE_DIFF_BUDGET, diffLines, unifiedDiffLines } from "./line-diff";

function numbered(count: number, prefix = "line"): string {
  return `${Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join("\n")}\n`;
}

describe("diffLines", () => {
  test("a one-line edit in a long file yields one minimal hunk", () => {
    const before = numbered(1_000);
    const after = before.replace("line 500\n", "line five hundred\n");
    const result = diffLines(before, after);
    expect(result.kind).toBe("diff");
    if (result.kind !== "diff") return;
    expect(result.additions).toBe(1);
    expect(result.deletions).toBe(1);
    expect(result.hunks).toHaveLength(1);
    expect(unifiedDiffLines(result.hunks)).toEqual([
      "@@ -497,7 +497,7 @@",
      " line 497",
      " line 498",
      " line 499",
      "-line 500",
      "+line five hundred",
      " line 501",
      " line 502",
      " line 503",
    ]);
  });

  test("identical sides produce no hunks", () => {
    const result = diffLines("a\nb\n", "a\nb\n");
    expect(result).toMatchObject({ kind: "diff", hunks: [], additions: 0, deletions: 0 });
  });

  test("pure insertion and deletion use unified empty-side starts", () => {
    const inserted = diffLines("a\nb\n", "a\nx\nb\n", { contextLines: 0 });
    expect(inserted.kind === "diff" && unifiedDiffLines(inserted.hunks)).toEqual([
      "@@ -1,0 +2,1 @@",
      "+x",
    ]);
    const deleted = diffLines("a\nx\nb\n", "a\nb\n", { contextLines: 0 });
    expect(deleted.kind === "diff" && unifiedDiffLines(deleted.hunks)).toEqual([
      "@@ -2,1 +1,0 @@",
      "-x",
    ]);
  });

  test("new and removed files are whole-side changes", () => {
    const created = diffLines("", "one\ntwo\n");
    expect(created).toMatchObject({ kind: "diff", additions: 2, deletions: 0 });
    const removed = diffLines("one\ntwo\n", "");
    expect(removed).toMatchObject({ kind: "diff", additions: 0, deletions: 2 });
  });

  test("distant edits become separate hunks and near edits merge", () => {
    const before = numbered(100);
    const distant = before.replace("line 10\n", "ten\n").replace("line 90\n", "ninety\n");
    const near = before.replace("line 10\n", "ten\n").replace("line 14\n", "fourteen\n");
    const distantResult = diffLines(before, distant);
    const nearResult = diffLines(before, near);
    expect(distantResult.kind === "diff" && distantResult.hunks.length).toBe(2);
    expect(nearResult.kind === "diff" && nearResult.hunks.length).toBe(1);
  });

  test("whitespace and carriage returns are real differences", () => {
    const result = diffLines("a\n\tb\nc\n", "a\n    b\nc\n");
    expect(result).toMatchObject({ kind: "diff", additions: 1, deletions: 1 });
    const crlf = diffLines("a\r\nb\r\n", "a\nb\n");
    expect(crlf).toMatchObject({ kind: "diff", additions: 2, deletions: 2 });
  });

  test("a missing trailing newline does not add a phantom line", () => {
    const result = diffLines("a\nb", "a\nb\n");
    expect(result).toMatchObject({ kind: "diff", hunks: [], oldLineCount: 2, newLineCount: 2 });
  });

  test("oversized inputs return a labelled too-large result", () => {
    const lines = DEFAULT_LINE_DIFF_BUDGET.maxLinesPerSide + 1;
    expect(diffLines(numbered(lines), "x\n")).toMatchObject({
      kind: "too-large",
      reason: "line-count",
      oldLineCount: lines,
    });
  });

  test("an edit distance beyond the budget is too large rather than coarse", () => {
    const before = numbered(50, "old");
    const after = numbered(50, "new");
    expect(diffLines(before, after, { maxEditDistance: 20 })).toMatchObject({
      kind: "too-large",
      reason: "edit-distance",
    });
    // The same change fits a sufficient budget exactly.
    expect(diffLines(before, after, { maxEditDistance: 100 })).toMatchObject({
      kind: "diff",
      additions: 50,
      deletions: 50,
    });
  });

  test("more rendered output than the inline budget is too large", () => {
    const before = numbered(400, "old");
    const after = numbered(400, "new");
    expect(diffLines(before, after, { maxOutputLines: 100 })).toMatchObject({
      kind: "too-large",
      reason: "output-lines",
    });
  });

  test("the edit script is minimal for interleaved changes", () => {
    const result = diffLines("a\nb\nc\nd\ne\n", "a\nc\nd\nx\ne\n");
    expect(result).toMatchObject({ kind: "diff", additions: 1, deletions: 1 });
    expect(result.kind === "diff" && unifiedDiffLines(result.hunks)).toEqual([
      "@@ -1,5 +1,5 @@",
      " a",
      "-b",
      " c",
      " d",
      "+x",
      " e",
    ]);
  });
});
