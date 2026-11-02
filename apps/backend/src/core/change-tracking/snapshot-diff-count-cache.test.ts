/**
 * ST-4: line counts are memoised by blob pair. A repeated comparison reads no
 * blobs and returns the same result; anything the bytes alone do not decide
 * is computed again; the cache keeps its count and byte bounds.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePath, type Manifest, type ManifestEntry } from "./capture.js";
import { ObjectStore } from "./object-store.js";
import { clearLineCountCache, compareManifests, lineCountCacheSnapshot } from "./snapshot-diff.js";

const directories: string[] = [];
beforeEach(() => clearLineCountCache());
afterEach(() => {
  clearLineCountCache();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** A store whose `get` calls are counted and whose objects can be hidden. */
function countingStore() {
  const directory = mkdtempSync(join(tmpdir(), "ork-count-cache-store-"));
  directories.push(directory);
  const store = new ObjectStore({ root: directory, durable: false });
  const hidden = new Set<string>();
  const counters = { gets: 0 };
  const get = store.get.bind(store);
  const has = store.has.bind(store);
  store.get = async (id) => {
    counters.gets++;
    return hidden.has(id) ? null : get(id);
  };
  store.has = async (id) => !hidden.has(id) && has(id);
  return { store, hidden, counters };
}

function lines(count: number, changedEvery = 0, tag = "x"): string {
  return Array.from({ length: count }, (_, index) =>
    changedEvery && index % changedEvery === 0 ? `${tag} ${index}\n` : `line ${index}\n`,
  ).join("");
}

async function entry(store: ObjectStore, path: string, text: string): Promise<ManifestEntry> {
  const bytes = new TextEncoder().encode(text);
  const written = await store.put("blob", bytes);
  return {
    p: encodePath(new TextEncoder().encode(path)),
    m: "100644",
    o: written.id,
    s: bytes.length,
    t: 1,
  };
}

function manifest(entries: ManifestEntry[]): Manifest {
  return {
    v: 1,
    root: "test",
    entries: entries.toSorted((a, b) => (a.p < b.p ? -1 : 1)),
    omitted: [],
    unstable: [],
  };
}

/** Modified, added and deleted text files plus a binary pair. */
async function fixture(store: ObjectStore) {
  const before = manifest([
    await entry(store, "modified.txt", lines(200)),
    await entry(store, "deleted.txt", lines(5)),
    await entry(store, "image.bin", "\0before"),
  ]);
  const after = manifest([
    await entry(store, "modified.txt", lines(200, 7)),
    await entry(store, "added.txt", lines(3)),
    await entry(store, "image.bin", "\0after"),
  ]);
  return { before, after };
}

describe("line-count memo (ST-4)", () => {
  test("a repeated comparison reads no blobs and returns the same result", async () => {
    const { store, counters } = countingStore();
    const { before, after } = await fixture(store);
    const first = await compareManifests(store, before, after);
    expect(counters.gets).toBe(6);
    expect(first.additions).toEqual({ value: 32, quality: "complete", bound: "exact" });

    const second = await compareManifests(store, before, after);
    expect(counters.gets).toBe(6);
    expect(second).toEqual(first);
    expect(lineCountCacheSnapshot()).toMatchObject({ entries: 4, hits: 4, misses: 4 });

    clearLineCountCache();
    expect(await compareManifests(store, before, after)).toEqual(first);
  });

  test("results handed out are copies; mutating one does not change the next", async () => {
    const { store } = countingStore();
    const { before, after } = await fixture(store);
    const first = await compareManifests(store, before, after);
    const modified = first.files.find(
      (file) => file.status === "modified" && file.fileKind === "text",
    )!;
    (modified.additions as { value: number | null }).value = 999;
    const second = await compareManifests(store, before, after);
    const again = second.files.find((file) => file.pathId === modified.pathId)!;
    expect(again.additions.value).toBe(29);
  });

  test("a blob the store no longer holds reads as unavailable, cached or not", async () => {
    const { store, hidden } = countingStore();
    const { before, after } = await fixture(store);
    await compareManifests(store, before, after);
    const added = after.entries.find((candidate) => candidate.s === lines(3).length)!;
    hidden.add(added.o);
    const cached = await compareManifests(store, before, after);
    clearLineCountCache();
    const uncached = await compareManifests(store, before, after);
    expect(cached).toEqual(uncached);
    expect(cached.reasons).toContain("body-unavailable");
    expect(cached.completeness).toBe("partial");
  });

  test("a wall-clock cpu-budget limit is not remembered", async () => {
    const { store } = countingStore();
    const { before, after } = await fixture(store);
    const limited = await compareManifests(store, before, after, { cpuBudgetMs: -1 });
    expect(limited.reasons).toContain("complexity-limit-cpu-budget");
    const counted = await compareManifests(store, before, after);
    expect(counted.reasons).toEqual([]);
    expect(counted.additions.value).toBe(32);
  });

  test("deterministic budgets are part of the key", async () => {
    const { store } = countingStore();
    const { before, after } = await fixture(store);
    const limited = await compareManifests(store, before, after, { maxInputBytes: 16 });
    expect(limited.reasons).toContain("complexity-limit-input-bytes");
    expect((await compareManifests(store, before, after)).additions.value).toBe(32);
    expect((await compareManifests(store, before, after, { maxInputBytes: 16 })).reasons).toContain(
      "complexity-limit-input-bytes",
    );
  });

  test("the cache keeps its count and byte bounds", async () => {
    const { store } = countingStore();
    const added = await Promise.all(
      Array.from({ length: 6 }, (_, index) => entry(store, `f${index}.txt`, lines(index + 1))),
    );
    clearLineCountCache({ maxEntries: 3 });
    await compareManifests(store, null, manifest(added));
    expect(lineCountCacheSnapshot().entries).toBe(3);

    clearLineCountCache({ maxBytes: 700 });
    await compareManifests(store, null, manifest(added));
    const snapshot = lineCountCacheSnapshot();
    expect(snapshot.entries).toBeGreaterThan(0);
    expect(snapshot.bytes).toBeLessThanOrEqual(700);
  });
});
