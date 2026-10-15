import { describe, expect, test } from "bun:test";
import { deepEqualJson } from "./message-identity";

describe("deepEqualJson", () => {
  test("compares nested plain data structurally", () => {
    expect(deepEqualJson({ a: 1, b: [1, { c: "x" }] }, { a: 1, b: [1, { c: "x" }] })).toBe(true);
    expect(deepEqualJson({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqualJson({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(deepEqualJson([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqualJson([1], { 0: 1 })).toBe(false);
    expect(deepEqualJson(null, {})).toBe(false);
    expect(deepEqualJson(undefined, undefined)).toBe(true);
  });

  test("handles deeply nested model output without overflowing the stack", () => {
    let left: Record<string, unknown> = {};
    let right: Record<string, unknown> = {};
    const leftRoot = left;
    const rightRoot = right;
    for (let index = 0; index < 20_000; index += 1) {
      left.next = {};
      right.next = {};
      left = left.next as Record<string, unknown>;
      right = right.next as Record<string, unknown>;
    }

    expect(deepEqualJson(leftRoot, rightRoot)).toBe(true);
    right.value = "different";
    expect(deepEqualJson(leftRoot, rightRoot)).toBe(false);
  });

  test("treats payloads beyond the comparison budget as changed", () => {
    const left = Array.from({ length: 100_001 }, () => ({ value: 1 }));
    const right = Array.from({ length: 100_001 }, () => ({ value: 1 }));
    expect(deepEqualJson(left, right)).toBe(false);
  });
});
