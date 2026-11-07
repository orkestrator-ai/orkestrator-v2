import { describe, expect, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import { createWindowByteBudgets, type WindowByteBudgets } from "@/lib/node-scope/byte-budget";
import { NodeByteCache } from "./rich-byte-cache";

const A = "bk_node-a" as BackendId;
const B = "bk_node-b" as BackendId;

function cacheOver(budgets: WindowByteBudgets, name = "test", maxEntries = 16) {
  return new NodeByteCache<string>({
    name,
    budget: "images",
    maxEntries,
    maxEntryBytes: 60,
    budgets: () => budgets,
  });
}

describe("NodeByteCache", () => {
  test("keys by (node, key): the same key on two nodes is two entries", () => {
    const budgets = createWindowByteBudgets({ images: 100 });
    const cache = cacheOver(budgets);
    cache.set(A, "same", "from-a", 10);
    cache.set(B, "same", "from-b", 10);
    expect(cache.get(A, "same")).toBe("from-a");
    expect(cache.get(B, "same")).toBe("from-b");
    expect(budgets.images.usedBytesFor(A)).toBe(10);
    expect(budgets.images.usedBytesFor(B)).toBe(10);
    cache.clearNode(A);
    expect(cache.get(A, "same")).toBeUndefined();
    expect(cache.get(B, "same")).toBe("from-b");
    expect(budgets.images.usedBytes).toBe(10);
  });

  test("two caches share one window budget; the budget evicts other nodes first", () => {
    const budgets = createWindowByteBudgets({ images: 100 });
    const first = cacheOver(budgets, "first");
    const second = cacheOver(budgets, "second");
    first.set(A, "a1", "a1", 40);
    second.set(A, "a2", "a2", 40);
    // B needs 40 more: A's least recently used entry goes, in the other cache.
    expect(first.set(B, "b1", "b1", 40)).toBe(true);
    expect(first.get(A, "a1")).toBeUndefined();
    expect(second.get(A, "a2")).toBe("a2");
    expect(budgets.images.usedBytes).toBe(80);
    expect(first.bytes + second.bytes).toBe(80);
  });

  test("the shown node is never evicted; a reservation that cannot fit is refused", () => {
    const budgets = createWindowByteBudgets({ images: 100 });
    const cache = cacheOver(budgets);
    budgets.images.setShownNode(A);
    cache.set(A, "a1", "a1", 50);
    cache.set(A, "a2", "a2", 40);
    expect(cache.set(B, "b1", "b1", 20)).toBe(false);
    expect(cache.get(A, "a1")).toBe("a1");
    expect(cache.get(A, "a2")).toBe("a2");
    expect(cache.has(B, "b1")).toBe(false);
    expect(budgets.images.usedBytes).toBe(90);
  });

  test("a refused rewrite drops the earlier value and its reservation", () => {
    const budgets = createWindowByteBudgets({ images: 100 });
    const cache = cacheOver(budgets);
    budgets.images.setShownNode(A);
    cache.set(A, "a", "a", 60);
    cache.set(B, "b", "small", 10);
    expect(cache.set(B, "b", "large", 50)).toBe(false);
    expect(cache.get(B, "b")).toBeUndefined();
    expect(budgets.images.usedBytesFor(B)).toBe(0);
  });

  test("bounds by count and by entry size", () => {
    const budgets = createWindowByteBudgets({ images: 1_000 });
    const cache = cacheOver(budgets, "test", 2);
    cache.set(A, "1", "1", 1);
    cache.set(A, "2", "2", 1);
    cache.get(A, "1");
    cache.set(A, "3", "3", 1);
    expect(cache.values().map((entry) => entry.key)).toEqual(["1", "3"]);
    expect(budgets.images.usedBytes).toBe(2);
    expect(cache.set(A, "huge", "x", 61)).toBe(false);
    expect(cache.size).toBe(2);
  });

  test("a released node's entries are gone without an eviction callback", () => {
    const budgets = createWindowByteBudgets({ images: 100 });
    const cache = cacheOver(budgets);
    cache.set(A, "a", "a", 30);
    cache.set(B, "b", "b", 30);
    // A node scope's dispose releases its reservations (`releaseNodeFromBudgets`).
    budgets.images.releaseNode(A);
    expect(cache.has(A, "a")).toBe(false);
    expect(cache.size).toBe(1);
    expect(cache.bytes).toBe(30);
  });

  test("entries reserved in a replaced budget are dropped", () => {
    let budgets = createWindowByteBudgets({ images: 100 });
    const cache = cacheOver(budgets);
    const swap = new NodeByteCache<string>({
      name: "swap",
      budget: "images",
      maxEntries: 4,
      budgets: () => budgets,
    });
    swap.set(A, "a", "a", 30);
    budgets = createWindowByteBudgets({ images: 100 });
    expect(swap.get(A, "a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });
});
