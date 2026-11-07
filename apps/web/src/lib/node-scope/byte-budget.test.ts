import { describe, expect, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import { ByteBudget, createWindowByteBudgets, DEFAULT_WINDOW_BYTE_BUDGETS } from "./byte-budget";

const SHOWN = "bk_shown" as BackendId;
const WARM_1 = "bk_warm-1" as BackendId;
const WARM_2 = "bk_warm-2" as BackendId;

const keysOf = (entries: readonly { nodeId: BackendId; key: string }[]) =>
  entries.map((entry) => `${entry.nodeId}/${entry.key}`);

describe("ByteBudget", () => {
  test("grants reservations within the total and counts them per node", () => {
    const budget = new ByteBudget("transcripts", 100);
    expect(budget.reserve(SHOWN, "a", 40)).toEqual({ granted: true, evicted: [] });
    expect(budget.reserve(WARM_1, "b", 60)).toEqual({ granted: true, evicted: [] });
    expect(budget.usedBytes).toBe(100);
    expect(budget.usedBytesFor(SHOWN)).toBe(40);
    expect(budget.has(WARM_1, "b")).toBe(true);
  });

  test("over the total, evicts least-recently-used entries of other nodes first, never the shown node", () => {
    const budget = new ByteBudget("transcripts", 100);
    budget.setShownNode(SHOWN);
    const evictedNotices: string[] = [];
    const onEvict = (entry: { nodeId: BackendId; key: string }) =>
      evictedNotices.push(`${entry.nodeId}/${entry.key}`);
    budget.reserve(SHOWN, "oldest", 30, { onEvict });
    budget.reserve(WARM_1, "w1-old", 20, { onEvict });
    budget.reserve(WARM_2, "w2", 20, { onEvict });
    budget.reserve(WARM_1, "w1-new", 20, { onEvict });
    // Touching moves w1-old to the most recently used end.
    budget.touch(WARM_1, "w1-old");

    const result = budget.reserve(SHOWN, "new", 40, { onEvict });

    expect(result.granted).toBe(true);
    // 130 requested of 100: frees 30 from other nodes, oldest first; the shown
    // node's own older entry is never a candidate.
    expect(keysOf(result.evicted)).toEqual([`${WARM_2}/w2`, `${WARM_1}/w1-new`]);
    expect(evictedNotices).toEqual([`${WARM_2}/w2`, `${WARM_1}/w1-new`]);
    expect(budget.has(SHOWN, "oldest")).toBe(true);
    expect(budget.has(WARM_1, "w1-old")).toBe(true);
    expect(budget.usedBytes).toBe(90);
  });

  test("a non-shown node evicts other nodes before its own older entries", () => {
    const budget = new ByteBudget("artifacts", 100);
    budget.setShownNode(SHOWN);
    budget.reserve(WARM_1, "own-old", 40);
    budget.reserve(WARM_2, "other", 40);

    const first = budget.reserve(WARM_1, "own-new", 40);
    expect(keysOf(first.evicted)).toEqual([`${WARM_2}/other`]);

    const second = budget.reserve(WARM_1, "own-newest", 40);
    expect(keysOf(second.evicted)).toEqual([`${WARM_1}/own-old`]);
  });

  test("refuses, evicting nothing, when only the shown node's entries could make room", () => {
    const budget = new ByteBudget("images", 100);
    budget.setShownNode(SHOWN);
    budget.reserve(SHOWN, "a", 70);
    budget.reserve(WARM_1, "b", 20);

    expect(budget.reserve(WARM_2, "c", 50)).toEqual({ granted: false, evicted: [] });
    expect(budget.reserve(SHOWN, "too-big", 101)).toEqual({ granted: false, evicted: [] });
    expect(budget.has(SHOWN, "a")).toBe(true);
    expect(budget.has(WARM_1, "b")).toBe(true);
    expect(budget.usedBytes).toBe(90);
  });

  test("the shown node makes room from other nodes first, then from its own older entries", () => {
    // Plan item 4002: a window showing one node can still page through its sessions.
    const budget = new ByteBudget("transcripts", 100);
    budget.setShownNode(SHOWN);
    budget.reserve(SHOWN, "own-old", 40);
    budget.reserve(WARM_1, "other", 30);
    budget.reserve(SHOWN, "own-mid", 30);

    expect(keysOf(budget.reserve(SHOWN, "own-new", 30).evicted)).toEqual([`${WARM_1}/other`]);
    expect(keysOf(budget.reserve(SHOWN, "own-newest", 40).evicted)).toEqual([`${SHOWN}/own-old`]);
    // Another node still cannot take the shown node's entries.
    expect(budget.reserve(WARM_2, "w2", 10)).toEqual({ granted: false, evicted: [] });
    expect(budget.usedBytes).toBe(100);
  });

  test("evictNode drops one node's entries and tells their owners", () => {
    const budget = new ByteBudget("images", 100);
    const notices: string[] = [];
    const onEvict = (entry: { nodeId: BackendId; key: string }) =>
      notices.push(`${entry.nodeId}/${entry.key}`);
    budget.reserve(WARM_1, "a", 10, { onEvict });
    budget.reserve(WARM_2, "b", 20, { onEvict });
    budget.reserve(WARM_1, "c", 30, { onEvict });
    expect(keysOf(budget.evictNode(WARM_1))).toEqual([`${WARM_1}/a`, `${WARM_1}/c`]);
    expect(notices).toEqual([`${WARM_1}/a`, `${WARM_1}/c`]);
    expect(budget.usedBytes).toBe(20);
    expect(budget.evictNode(WARM_1)).toEqual([]);
  });

  test("re-reserving a key replaces its size and keeps its eviction notice", () => {
    const budget = new ByteBudget("transcripts", 100);
    const notices: string[] = [];
    budget.reserve(WARM_1, "session", 50, { onEvict: (entry) => notices.push(entry.key) });
    budget.reserve(WARM_1, "session", 80);
    expect(budget.usedBytes).toBe(80);
    budget.reserve(SHOWN, "next", 30);
    expect(notices).toEqual(["session"]);
  });

  test("evictUntil frees room best-effort by the same policy, sparing the key and the shown node", () => {
    const budget = new ByteBudget("transcripts", 100);
    budget.setShownNode(SHOWN);
    const notices: string[] = [];
    const onEvict = (entry: { nodeId: BackendId; key: string }) =>
      notices.push(`${entry.nodeId}/${entry.key}`);
    budget.reserve(SHOWN, "shown", 30, { onEvict });
    budget.reserve(WARM_1, "own-old", 20, { onEvict });
    budget.reserve(WARM_2, "other", 20, { onEvict });
    budget.reserve(WARM_1, "reader", 20, { onEvict });

    // Other nodes first, then the reader's own older entries.
    expect(keysOf(budget.evictUntil(WARM_1, "reader", 70))).toEqual(["bk_warm-2/other"]);
    expect(budget.usedBytes).toBe(70);
    // Cannot reach the target: evicts what it may (never "shown" or "reader").
    expect(keysOf(budget.evictUntil(WARM_1, "reader", 0))).toEqual(["bk_warm-1/own-old"]);
    expect(notices).toEqual(["bk_warm-2/other", "bk_warm-1/own-old"]);
    expect(budget.usedBytes).toBe(50);
    expect(budget.evictUntil(WARM_1, "reader", 50)).toEqual([]);
  });

  test("release and releaseNode give bytes back without eviction notices", () => {
    const budget = new ByteBudget("transcripts", 100);
    const notices: string[] = [];
    const onEvict = (entry: { key: string }) => notices.push(entry.key);
    budget.reserve(WARM_1, "a", 10, { onEvict });
    budget.reserve(WARM_1, "b", 20, { onEvict });
    budget.reserve(WARM_2, "c", 30, { onEvict });
    budget.release(WARM_1, "a");
    budget.release(WARM_1, "missing");
    expect(budget.usedBytes).toBe(50);
    budget.releaseNode(WARM_1);
    expect(budget.usedBytes).toBe(30);
    expect(budget.usedBytesFor(WARM_1)).toBe(0);
    expect(notices).toEqual([]);
  });

  test("rejects sizes that are not non-negative integers", () => {
    expect(() => new ByteBudget("x", -1)).toThrow();
    const budget = new ByteBudget("x", 10);
    expect(() => budget.reserve(WARM_1, "a", 1.5)).toThrow();
    expect(() => budget.reserve(WARM_1, "a", Number.NaN)).toThrow();
  });

  test("window budgets default to the documented totals", () => {
    const budgets = createWindowByteBudgets({ images: 5 });
    expect(budgets.transcripts.totalBytes).toBe(DEFAULT_WINDOW_BYTE_BUDGETS.transcripts);
    expect(budgets.artifacts.totalBytes).toBe(DEFAULT_WINDOW_BYTE_BUDGETS.artifacts);
    expect(budgets.images.totalBytes).toBe(5);
  });
});
