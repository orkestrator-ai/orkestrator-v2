import { describe, expect, test } from "bun:test";
import { RecentlyRevisedRows } from "./revised-rows.js";

describe("recently revised rows", () => {
  test("lists ids newest note first and moves a re-noted id to the front", () => {
    const rows = new RecentlyRevisedRows(3);
    rows.note("a");
    rows.note("b");
    rows.note("a");
    expect(rows.ids()).toEqual(["a", "b"]);
  });

  test("drops the oldest note past its bound, and forgets on request", () => {
    const rows = new RecentlyRevisedRows(2);
    rows.note("a");
    rows.note("b");
    rows.note("c");
    expect(rows.ids()).toEqual(["c", "b"]);
    rows.forget("c");
    expect(rows.ids()).toEqual(["b"]);
  });
});

test("losing revision notes moves a bounded recovery version until history resets", () => {
  const rows = new RecentlyRevisedRows(2);
  rows.note("a");
  rows.note("b");
  expect(rows.overflowVersion).toBe(0);
  rows.note("c");
  expect(rows.overflowVersion).toBe(1);
  rows.note("a");
  expect(rows.overflowVersion).toBe(2);
  rows.clear();
  expect(rows.overflowVersion).toBe(0);
});
