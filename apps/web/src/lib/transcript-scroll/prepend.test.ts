import { describe, expect, test } from "bun:test";
import { pureprependCount } from "./prepend";

const rows = (...ids: string[]) => ids.map((id) => ({ id }));
const keyAt = (list: readonly { id: string }[], index: number) => list[index]!.id;
const count = (previous: { id: string }[], next: { id: string }[]) =>
  pureprependCount(previous, next, keyAt);

describe("pureprependCount", () => {
  test("counts display rows added in front", () => {
    expect(count(rows("c", "d"), rows("a", "b", "c", "d"))).toBe(2);
  });

  test("ignores an ordinary streaming update and appended rows", () => {
    expect(count(rows("a", "b"), rows("a", "b", "c"))).toBe(0);
  });

  test("tolerates a live append alongside the prepend", () => {
    expect(count(rows("c", "d"), rows("a", "b", "c", "d", "e"))).toBe(2);
  });

  test("tolerates the streaming tail row being replaced", () => {
    expect(count(rows("c", "d", "tail"), rows("a", "b", "c", "d", "tail:final"))).toBe(2);
  });

  test("a page that merges into and renames the old first row is located by the next row", () => {
    // "c" coalesced with earlier members and became "b2"; "d" is unchanged.
    expect(count(rows("c", "d", "e"), rows("a", "b2", "d", "e"))).toBe(1);
  });

  test("a merge that adds no row is zero", () => {
    expect(count(rows("c", "d"), rows("c2", "d"))).toBe(0);
  });

  test("a replacement or reorder is not a prepend", () => {
    expect(count(rows("a", "b"), rows("x", "y"))).toBe(0);
    expect(count(rows("a", "b", "c"), rows("z", "a", "c", "b"))).toBe(0);
    expect(count([], rows("a"))).toBe(0);
  });
});
