import { describe, expect, test } from "bun:test";
import {
  LIVE_ARRIVAL_WINDOW_MS,
  MAX_LIVE_ARRIVALS,
  liveArrivals,
  takeLiveArrival,
  type LiveArrivalBatch,
} from "./arrivals";

const rows = (...ids: string[]) => ids.map((id) => ({ id }));
const keyAt = (list: readonly { id: string }[], index: number) => list[index]!.id;
const arrivals = (previous: { id: string }[], next: { id: string }[]) =>
  liveArrivals(previous, next, keyAt).sort();

describe("liveArrivals", () => {
  test("rows appended at the end arrive", () => {
    expect(arrivals(rows("a", "b"), rows("a", "b", "c"))).toEqual(["c"]);
    expect(arrivals(rows("a", "b"), rows("a", "b", "c", "d"))).toEqual(["c", "d"]);
  });

  test("a row inserted before the tail arrives (an optimistic prompt)", () => {
    expect(arrivals(rows("a", "b", "c"), rows("a", "b", "p", "c"))).toEqual(["p"]);
  });

  test("an ordinary streaming update adds nothing", () => {
    expect(arrivals(rows("a", "b"), rows("a", "b"))).toEqual([]);
  });

  test("a first fill, rehydration or refill renders at once", () => {
    expect(arrivals([], rows("a"))).toEqual([]);
    const many = Array.from({ length: MAX_LIVE_ARRIVALS + 1 }, (_, i) => `n${i}`);
    expect(arrivals(rows("a"), rows("a", ...many))).toEqual([]);
  });

  test("a history prepend, with or without a live append, renders at once", () => {
    expect(arrivals(rows("c", "d"), rows("a", "b", "c", "d"))).toEqual([]);
    expect(arrivals(rows("c", "d"), rows("b", "c", "d", "e"))).toEqual([]);
  });

  test("a replaced row is not an arrival, even alongside an append", () => {
    // The optimistic prompt replaced by its echo, and the assistant's first row.
    expect(arrivals(rows("a", "b", "opt"), rows("a", "b", "echo"))).toEqual([]);
    expect(arrivals(rows("a", "b", "opt"), rows("a", "b", "echo", "reply"))).toEqual([]);
    expect(arrivals(rows("a", "b", "c"), rows("a", "c", "d"))).toEqual([]);
  });

  test("a removal is not an arrival", () => {
    expect(arrivals(rows("a", "b", "c"), rows("a", "b"))).toEqual([]);
  });
});

function batch(...keys: string[]): LiveArrivalBatch {
  return { keys: new Set(keys), stampedAt: null, taken: new Set() };
}

describe("takeLiveArrival", () => {
  test("each arrival animates once", () => {
    const update = batch("c");
    expect(takeLiveArrival(update, "c", 10)).toBe(true);
    expect(takeLiveArrival(update, "c", 20)).toBe(false);
    expect(takeLiveArrival(update, "b", 20)).toBe(false);
  });

  test("an arrival mounted after its window renders at once", () => {
    const update = batch("c", "d");
    expect(takeLiveArrival(update, "c", 100)).toBe(true);
    expect(takeLiveArrival(update, "d", 100 + LIVE_ARRIVAL_WINDOW_MS + 1)).toBe(false);
  });

  test("the window starts at the first use", () => {
    const update = batch("c");
    update.stampedAt = 0;
    expect(takeLiveArrival(update, "c", LIVE_ARRIVAL_WINDOW_MS + 1)).toBe(false);
  });
});
