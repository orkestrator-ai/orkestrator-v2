import { describe, expect, test } from "bun:test";
import {
  applyDiffBudget,
  applyToolResultBudget,
  MAX_DIFF_SIDE_BYTES,
  MAX_TOOL_TEXT_BYTES,
  TRUNCATED_NOTICE,
} from "./part-budget.js";

describe("part budget", () => {
  test("adds compact stats to ordinary payloads", () => {
    const metadata = { filePath: "/a.ts", before: "old", after: "new" };
    expect(applyDiffBudget(metadata)).toEqual({
      ...metadata,
      additions: 1,
      deletions: 1,
    });
    expect(applyToolResultBudget({ output: "fine" })).toEqual({
      output: "fine",
      error: undefined,
    });
  });

  test("caps a written file without losing the path or the head", () => {
    const content = `${"a".repeat(MAX_DIFF_SIDE_BYTES + 5_000)}TAIL`;
    const capped = applyDiffBudget({ filePath: "/big.ts", before: "", after: content })!;

    expect(capped.filePath).toBe("/big.ts");
    expect(capped.after).toStartWith("aaa");
    expect(capped.after).toEndWith(TRUNCATED_NOTICE);
    expect(capped.after).not.toContain("TAIL");
    expect(Buffer.byteLength(capped.after!, "utf8")).toBeLessThan(
      MAX_DIFF_SIDE_BYTES + TRUNCATED_NOTICE.length + 8,
    );
    // The other side was already small and must be untouched.
    expect(capped.before).toBe("");
    expect(capped.additions).toBe(1);
    expect(capped.deletions).toBe(0);
  });

  test("caps the before side independently of the after side", () => {
    // A large `old_string` on an Edit is the mirror of a large Write, and only
    // the oversized side may be rewritten.
    const before = "b".repeat(MAX_DIFF_SIDE_BYTES + 100);
    const capped = applyDiffBudget({ filePath: "/a.ts", before, after: "small" })!;

    expect(capped.before).toEndWith(TRUNCATED_NOTICE);
    expect(capped.after).toBe("small");
    expect(capped.filePath).toBe("/a.ts");
    expect(capped.additions).toBe(1);
    expect(capped.deletions).toBe(1);
  });

  test("leaves a payload sitting exactly on the limit alone", () => {
    // The cap is inclusive, so a value at exactly the budget must not gain a
    // truncation notice it does not need.
    const exact = "x".repeat(MAX_TOOL_TEXT_BYTES);
    const capped = applyToolResultBudget({ output: exact });

    expect(capped.output).toBe(exact);
    expect(capped.output).not.toContain(TRUNCATED_NOTICE);

    const oneOver = `${exact}y`;
    expect(applyToolResultBudget({ output: oneOver }).output).toEndWith(TRUNCATED_NOTICE);
  });

  test("passes an empty string through untouched", () => {
    expect(applyToolResultBudget({ output: "" })).toEqual({ output: "", error: undefined });
    const metadata = { filePath: "/a.ts", before: "", after: "" };
    expect(applyDiffBudget(metadata)).toEqual({
      ...metadata,
      additions: 0,
      deletions: 0,
    });
  });

  test("preserves provider-supplied stats and counts before truncation", () => {
    expect(applyDiffBudget({
      before: "ignored",
      after: "ignored",
      additions: 7,
      deletions: 3,
    })).toMatchObject({ additions: 7, deletions: 3 });

    const manyLines = `${"line\n".repeat(150_000)}tail`;
    const capped = applyDiffBudget({ before: "old\n", after: manyLines })!;
    expect(capped.additions).toBe(150_001);
    expect(capped.deletions).toBe(1);
    expect(capped.after).toEndWith(TRUNCATED_NOTICE);
  });

  test("returns undefined metadata unchanged", () => {
    expect(applyDiffBudget(undefined)).toBeUndefined();
  });

  test("caps oversized tool output and error text", () => {
    const output = "o".repeat(MAX_TOOL_TEXT_BYTES + 1_000);
    const error = "e".repeat(MAX_TOOL_TEXT_BYTES + 1_000);

    const capped = applyToolResultBudget({ output, error });
    expect(capped.output).toEndWith(TRUNCATED_NOTICE);
    expect(capped.error).toEndWith(TRUNCATED_NOTICE);
    expect(capped.output!.length).toBeLessThan(output.length);
  });

  test("never splits a multi-byte character", () => {
    // Every character is 4 bytes, so the budget lands mid-sequence.
    const emoji = "😀".repeat(MAX_TOOL_TEXT_BYTES);
    const capped = applyToolResultBudget({ output: emoji }).output!;

    expect(capped).not.toContain("�");
    // Round-tripping proves no lone surrogate survived the cut.
    expect(Buffer.from(capped, "utf8").toString("utf8")).toBe(capped);
  });

});
