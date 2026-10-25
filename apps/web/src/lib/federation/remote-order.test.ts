import { describe, expect, test } from "bun:test";
import { moveId, sameOrder, withOrder } from "./remote-order";

describe("remote sidebar order", () => {
  test("moveId moves the dragged id to the drop target's slot", () => {
    expect(moveId(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
    expect(moveId(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
  });

  test("moveId reports a no-op or unknown id as null", () => {
    expect(moveId(["a", "b"], "a", "a")).toBeNull();
    expect(moveId(["a", "b"], "a", "z")).toBeNull();
    expect(moveId(["a", "b"], "z", "a")).toBeNull();
  });

  test("withOrder applies a pending order and keeps unnamed items after it, in their own order", () => {
    const items = ["new-1", "a", "b", "new-2", "c"];
    expect(withOrder(items, ["c", "a", "gone", "b"], (item) => item)).toEqual([
      "c",
      "a",
      "b",
      "new-1",
      "new-2",
    ]);
    expect(withOrder(items, undefined, (item) => item)).toBe(items);
  });

  test("sameOrder compares position by position", () => {
    expect(sameOrder(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameOrder(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameOrder(["a"], ["a", "b"])).toBe(false);
  });
});
