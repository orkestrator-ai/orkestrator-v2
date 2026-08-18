import { describe, expect, test } from "bun:test";
import type { FileMention } from "@/types";
import { fileMentionsEqual } from "./file-mentions-equal";

function mention(overrides: Partial<FileMention> = {}): FileMention {
  return {
    id: "mention-1",
    filename: "app.ts",
    relativePath: "src/app.ts",
    ...overrides,
  } as FileMention;
}

describe("fileMentionsEqual", () => {
  test("treats value-identical arrays from separate reads as equal", () => {
    /**
     * The whole reason this helper exists: the store returns a fresh array on
     * every read, so a reference check would report "changed" after every send
     * and leave the composer holding a draft the user already submitted.
     */
    expect(fileMentionsEqual([mention()], [mention()])).toBe(true);
  });

  test("short-circuits on reference equality", () => {
    const mentions = [mention()];
    expect(fileMentionsEqual(mentions, mentions)).toBe(true);
  });

  test("treats two empty lists as equal", () => {
    expect(fileMentionsEqual([], [])).toBe(true);
  });

  test("reports a length difference as unequal in both directions", () => {
    expect(fileMentionsEqual([mention()], [])).toBe(false);
    expect(fileMentionsEqual([], [mention()])).toBe(false);
  });

  test("compares id, filename and relativePath", () => {
    expect(fileMentionsEqual([mention()], [mention({ id: "mention-2" })])).toBe(false);
    expect(fileMentionsEqual([mention()], [mention({ filename: "other.ts" })])).toBe(false);
    expect(fileMentionsEqual([mention()], [mention({ relativePath: "lib/app.ts" })])).toBe(false);
  });

  test("is order sensitive", () => {
    const a = mention({ id: "a" });
    const b = mention({ id: "b" });
    expect(fileMentionsEqual([a, b], [b, a])).toBe(false);
    expect(fileMentionsEqual([a, b], [a, b])).toBe(true);
  });

  test("distinguishes a duplicated mention from a single one", () => {
    expect(fileMentionsEqual([mention(), mention()], [mention()])).toBe(false);
  });
});
