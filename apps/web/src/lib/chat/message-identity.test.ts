import { describe, expect, test } from "bun:test";
import { deepEqualJson, preserveMessageIdentities } from "./message-identity";
import type { NativeMessage } from "./native-message-types";

function message(id: string, content: string, extra: Partial<NativeMessage> = {}): NativeMessage {
  return {
    id,
    role: "assistant",
    content,
    parts: [{ type: "text", content }],
    createdAt: "2026-04-15T10:00:00.000Z",
    ...extra,
  };
}

describe("deepEqualJson", () => {
  test("compares nested plain data structurally", () => {
    expect(deepEqualJson(
      { a: 1, b: [1, { c: "x" }] },
      { a: 1, b: [1, { c: "x" }] },
    )).toBe(true);
    expect(deepEqualJson({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqualJson({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(deepEqualJson([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqualJson([1], { 0: 1 })).toBe(false);
    expect(deepEqualJson(null, {})).toBe(false);
    expect(deepEqualJson(undefined, undefined)).toBe(true);
  });
});

describe("preserveMessageIdentities", () => {
  test("returns the existing array itself for a value-identical snapshot", () => {
    const existing = [message("m-1", "one"), message("m-2", "two")];
    const next = [message("m-1", "one"), message("m-2", "two")];

    expect(preserveMessageIdentities(existing, next)).toBe(existing);
  });

  test("reuses existing objects for unchanged messages and keeps changed ones fresh", () => {
    const existing = [message("m-1", "one"), message("m-2", "two")];
    const next = [message("m-1", "one"), message("m-2", "two updated")];

    const result = preserveMessageIdentities(existing, next);

    expect(result).not.toBe(existing);
    expect(result[0]).toBe(existing[0]!);
    expect(result[1]).toBe(next[1]!);
  });

  test("handles additions, removals, and reorders without losing data", () => {
    const existing = [message("m-1", "one"), message("m-2", "two")];
    const next = [message("m-2", "two"), message("m-3", "three")];

    const result = preserveMessageIdentities(existing, next);

    expect(result.map((entry) => entry.id)).toEqual(["m-2", "m-3"]);
    expect(result[0]).toBe(existing[1]!);
    expect(result[1]).toBe(next[1]!);
  });

  test("a cheap structural difference (part count) skips the deep compare and keeps the new object", () => {
    const existing = [message("m-1", "one")];
    const next = [
      {
        ...message("m-1", "one"),
        parts: [
          { type: "text" as const, content: "one" },
          { type: "text" as const, content: "more" },
        ],
      },
    ];

    const result = preserveMessageIdentities(existing, next);
    expect(result[0]).toBe(next[0]!);
  });

  test("returns next untouched when nothing matches by id", () => {
    const existing = [message("m-1", "one")];
    const next = [message("m-9", "nine")];

    expect(preserveMessageIdentities(existing, next)).toBe(next);
  });
});
