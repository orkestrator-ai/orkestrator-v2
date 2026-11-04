import { describe, expect, test } from "bun:test";
import { samePart, samePartContent } from "./same-transcript-part";

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

describe("samePart", () => {
  const cases: Array<[string, unknown, unknown]> = [
    ["equal objects", { a: 1, b: [1, { c: "x" }] }, { a: 1, b: [1, { c: "x" }] }],
    ["different value", { a: 1 }, { a: 2 }],
    ["key order differs", { a: 1, b: 2 }, { b: 2, a: 1 }],
    ["missing key", { a: 1 }, { a: 1, b: 2 }],
    ["undefined value against absent key", { a: 1, b: undefined }, { a: 1 }],
    ["nested undefined against absent key", { a: { b: undefined } }, { a: {} }],
    ["array against object", { a: [] }, { a: {} }],
    ["arrays of different length", [1, 2], [1, 2, 3]],
    ["null against object", { a: null }, { a: {} }],
    ["null against zero", { a: null }, { a: 0 }],
    ["number against its string", { a: 1 }, { a: "1" }],
    ["primitives", "text", "text"],
    ["both undefined", undefined, undefined],
  ];

  for (const [name, a, b] of cases) {
    test(`agrees with comparing JSON: ${name}`, () => {
      expect(samePart(a, b)).toBe(jsonEqual(a, b));
    });
  }
});

describe("samePartContent", () => {
  test("ignores identity fields at the top level only", () => {
    const part = { type: "text", content: "x", sourcePartId: "a", createdAt: "1" };
    expect(samePartContent(part, { ...part, sourcePartId: "b", createdAt: "2" })).toBe(true);
    expect(samePartContent(part, { ...part, content: "y" })).toBe(false);
    expect(
      samePartContent({ nested: { sourcePartId: "a" } }, { nested: { sourcePartId: "b" } }),
    ).toBe(false);
  });
});
