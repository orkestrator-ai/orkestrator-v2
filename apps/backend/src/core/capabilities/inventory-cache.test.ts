/**
 * The provider plugin listings are shared by concurrent readers, kept for
 * their window, and never served across a change this machine applied.
 */
import { describe, expect, test } from "bun:test";

import { InventoryPluginCache } from "./inventory-cache.js";
import type { InventoryPluginListing } from "./inventory.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const listing = (name: string): InventoryPluginListing => ({
  plugins: [{ provider: "codex", qualifiedId: name, name, enabled: true }],
});

describe("InventoryPluginCache", () => {
  test("concurrent readers share one listing in flight", async () => {
    let loads = 0;
    const gate = deferred<InventoryPluginListing>();
    const cache = new InventoryPluginCache(() => {
      loads += 1;
      return gate.promise;
    });
    const reads = [cache.read(), cache.read(), cache.read({ refresh: true })];
    await Promise.resolve();
    gate.resolve(listing("a"));
    const results = await Promise.all(reads);
    expect(loads).toBe(1);
    expect(results.map((result) => result.plugins[0]!.name)).toEqual(["a", "a", "a"]);
  });

  test("a settled listing serves readers within its window, then lists again", async () => {
    let clock = 1_000;
    let loads = 0;
    const cache = new InventoryPluginCache(async () => listing(`load-${++loads}`), {
      ttlMs: 60_000,
      now: () => clock,
    });
    expect((await cache.read()).plugins[0]!.name).toBe("load-1");
    clock += 59_000;
    expect((await cache.read()).plugins[0]!.name).toBe("load-1");
    clock += 1_000;
    expect((await cache.read()).plugins[0]!.name).toBe("load-2");
    expect(loads).toBe(2);
  });

  test("refresh skips a settled listing", async () => {
    let loads = 0;
    const cache = new InventoryPluginCache(async () => listing(`load-${++loads}`));
    await cache.read();
    expect((await cache.read({ refresh: true })).plugins[0]!.name).toBe("load-2");
    expect((await cache.read()).plugins[0]!.name).toBe("load-2");
  });

  test("a change lists again, and a listing begun before it is never served after it", async () => {
    const gates: Array<ReturnType<typeof deferred<InventoryPluginListing>>> = [];
    const cache = new InventoryPluginCache(() => {
      const gate = deferred<InventoryPluginListing>();
      gates.push(gate);
      return gate.promise;
    });
    const before = cache.read();
    await Promise.resolve();
    const generation = cache.generation;
    cache.invalidate();
    expect(cache.generation).toBe(generation + 1);
    const after = cache.read();
    await Promise.resolve();
    expect(gates).toHaveLength(2);
    gates[0]!.resolve(listing("old"));
    gates[1]!.resolve(listing("new"));
    expect((await before).plugins[0]!.name).toBe("old");
    expect((await after).plugins[0]!.name).toBe("new");
    expect((await cache.read()).plugins[0]!.name).toBe("new");
    expect(gates).toHaveLength(2);
  });

  test("a failed listing is not kept", async () => {
    let loads = 0;
    const cache = new InventoryPluginCache(async () => {
      loads += 1;
      if (loads === 1) throw new Error("boom");
      return listing("ok");
    });
    await expect(cache.read()).rejects.toThrow("boom");
    expect((await cache.read()).plugins[0]!.name).toBe("ok");
    expect(loads).toBe(2);
  });
});
