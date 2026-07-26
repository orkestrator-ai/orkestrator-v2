import { describe, expect, test } from "bun:test";
import {
  applyDiffBudget,
  applyPartBudget,
  applyToolResultBudget,
  MAX_DIFF_SIDE_BYTES,
  MAX_TOOL_TEXT_BYTES,
  TRUNCATED_NOTICE,
} from "./part-budget.js";

describe("part budget", () => {
  test("leaves ordinary payloads exactly as they are", () => {
    const metadata = { filePath: "/a.ts", before: "old", after: "new" };
    // Identity, not just equality: an untouched turn must not pay for a copy.
    expect(applyDiffBudget(metadata)).toBe(metadata);
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

  test("bounds every unbounded field of a part at once", () => {
    const part = applyPartBudget({
      type: "tool-invocation",
      toolName: "Write",
      toolOutput: "o".repeat(MAX_TOOL_TEXT_BYTES + 10),
      toolError: undefined,
      toolDiff: {
        filePath: "/x.ts",
        after: "a".repeat(MAX_DIFF_SIDE_BYTES + 10),
      },
    });

    expect(part.toolOutput).toEndWith(TRUNCATED_NOTICE);
    expect(part.toolDiff!.after).toEndWith(TRUNCATED_NOTICE);
    expect(part.toolError).toBeUndefined();
    expect(part.toolName).toBe("Write");
  });
});
