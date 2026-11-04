/**
 * ST-5: repeat manifest reads do not parse, the shared copy cannot be changed,
 * the cache is bounded, and an expired snapshot still reads as expired.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureWorktree, HostCaptureExecutor, readManifest, type Manifest } from "./capture.js";
import { ManifestCache, PARSED_BYTES_PER_SERIALIZED_BYTE } from "./manifest-cache.js";
import { ObjectStore, type ObjectStoreOptions } from "./object-store.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function openStore(options: Partial<ObjectStoreOptions> = {}): ObjectStore {
  return new ObjectStore({ root: temp("ork-manifest-store-"), durable: false, ...options });
}

function manifestOf(name: string, files = 1): Manifest {
  return {
    v: 1,
    root: name,
    entries: Array.from({ length: files }, (_, index) => ({
      p: `u:${name}/${String(index).padStart(5, "0")}`,
      m: "100644" as const,
      o: "a".repeat(40),
      s: index,
      t: 1 as const,
    })),
    omitted: [{ p: `u:${name}/big`, reason: "too-large" as const, size: 9, stamp: "s" }],
    unstable: [`u:${name}/moving`],
  };
}

async function stored(store: ObjectStore, manifest: Manifest): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  return (await store.put("manifest", bytes)).id;
}

function objectFile(store: ObjectStore, id: string): string {
  return join(store.root, "objects", id.slice(0, 2), id.slice(2));
}

describe("readManifest through the cache", () => {
  test("a repeat read neither reads the object nor parses it again", async () => {
    const store = openStore();
    const id = await stored(store, manifestOf("repeat"));
    const first = await readManifest(store, id);
    expect(store.manifests.snapshot().parses).toBe(1);

    const parse = spyOn(JSON, "parse");
    const read = spyOn(store, "get");
    try {
      const second = await readManifest(store, id);
      const third = await readManifest(store, id);
      expect(second).toBe(first);
      expect(third).toBe(first);
      expect(parse).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
      read.mockRestore();
    }
    expect(store.manifests.snapshot()).toMatchObject({ parses: 1, hits: 2, misses: 1 });
  });

  test("a capture leaves its manifest cached, so the first read does not parse", async () => {
    const repo = temp("ork-manifest-repo-");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    writeFileSync(join(repo, "a.txt"), "a\n");
    const store = openStore();
    const result = await captureWorktree({ executor: new HostCaptureExecutor(repo), store });
    if (result.kind !== "captured") throw new Error(result.reason);
    expect(await readManifest(store, result.manifestId)).toBe(result.manifest);
    expect(store.manifests.snapshot().parses).toBe(0);
    expect(Object.isFrozen(result.manifest.entries[0])).toBe(true);
  });

  test("the shared manifest is deeply immutable", async () => {
    const store = openStore();
    const id = await stored(store, manifestOf("frozen"));
    const manifest = (await readManifest(store, id)) as unknown as {
      root: string;
      entries: Array<{ o: string }>;
      omitted: Array<{ size: number }>;
      unstable: string[];
    };
    expect(() => (manifest.root = "changed")).toThrow(TypeError);
    expect(() => manifest.entries.push({ o: "x" })).toThrow(TypeError);
    expect(() => (manifest.entries[0]!.o = "x")).toThrow(TypeError);
    expect(() => manifest.omitted.pop()).toThrow(TypeError);
    expect(() => (manifest.omitted[0]!.size = 1)).toThrow(TypeError);
    expect(() => manifest.unstable.push("x")).toThrow(TypeError);
    expect(await readManifest(store, id)).toEqual(manifestOf("frozen"));
  });

  test("a hit is refused once the object is gone, and the entry goes with it", async () => {
    const store = openStore();
    const removed = await stored(store, manifestOf("removed"));
    const swept = await stored(store, manifestOf("swept"));
    expect(await readManifest(store, removed)).not.toBeNull();
    expect(await readManifest(store, swept)).not.toBeNull();
    expect(store.manifests.snapshot().entries).toBe(2);

    unlinkSync(objectFile(store, removed));
    expect(await readManifest(store, removed)).toBeNull();

    const old = new Date(Date.now() - 60_000);
    utimesSync(objectFile(store, swept), old, old);
    await store.sweep(new Set(), 1_000);
    expect(await readManifest(store, swept)).toBeNull();
    expect(store.manifests.snapshot().entries).toBe(0);
  });

  test("a cached entry is not an answer for a store that lacks the object", async () => {
    const store = openStore();
    const other = openStore();
    const id = await stored(store, manifestOf("elsewhere"));
    await readManifest(store, id);
    expect(await readManifest(other, id)).toBeNull();
  });

  test("a scan uses a hit but does not fill the cache", async () => {
    const store = openStore({ manifestCache: { maxEntries: 2 } });
    const hot = await stored(store, manifestOf("hot"));
    const manifest = await readManifest(store, hot);
    for (let index = 0; index < 5; index++) {
      const cold = await stored(store, manifestOf(`cold-${index}`));
      expect(await readManifest(store, cold, { scan: true })).toEqual(manifestOf(`cold-${index}`));
    }
    expect(await readManifest(store, hot, { scan: true })).toBe(manifest);
    expect(store.manifests.snapshot()).toMatchObject({ entries: 1, parses: 6 });
  });

  test("unreadable and non-manifest objects read as absent and stay uncached", async () => {
    const store = openStore();
    const { id: notJson } = await store.put("manifest", new TextEncoder().encode("{"));
    const { id: wrongVersion } = await store.put(
      "manifest",
      new TextEncoder().encode(JSON.stringify({ v: 2, entries: [] })),
    );
    expect(await readManifest(store, notJson)).toBeNull();
    expect(await readManifest(store, wrongVersion)).toBeNull();
    expect(await readManifest(store, "not-an-id")).toBeNull();
    expect(store.manifests.snapshot().entries).toBe(0);
  });
});

describe("the cache's bounds", () => {
  test("the count bound evicts the least recently used entry", async () => {
    const store = openStore({ manifestCache: { maxEntries: 2 } });
    const [a, b, c] = await Promise.all(
      ["a", "b", "c"].map((name) => stored(store, manifestOf(name))),
    );
    await readManifest(store, a!);
    await readManifest(store, b!);
    await readManifest(store, a!); // b is now the oldest
    await readManifest(store, c!);
    expect(store.manifests.snapshot().entries).toBe(2);

    const parses = store.manifests.snapshot().parses;
    await readManifest(store, a!);
    expect(store.manifests.snapshot().parses).toBe(parses);
    await readManifest(store, b!);
    expect(store.manifests.snapshot().parses).toBe(parses + 1);
  });

  test("the byte bound evicts down to the bound, counting the estimated parsed size", () => {
    const cache = new ManifestCache({ maxBytes: 1_000 });
    const size = 200; // 400 estimated at the factor of 2
    expect(PARSED_BYTES_PER_SERIALIZED_BYTE).toBe(2);
    cache.remember("a", manifestOf("a"), size);
    cache.remember("b", manifestOf("b"), size);
    expect(cache.snapshot()).toMatchObject({ entries: 2, bytes: 800 });
    cache.remember("c", manifestOf("c"), size);
    expect(cache.snapshot()).toMatchObject({ entries: 2, bytes: 800 });
    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).not.toBeNull();
    expect(cache.get("c")).not.toBeNull();
  });

  test("a manifest over the byte bound is returned frozen and is not kept", () => {
    const cache = new ManifestCache({ maxBytes: 1_000 });
    cache.remember("small", manifestOf("small"), 100);
    const large = cache.remember("large", manifestOf("large"), 501);
    expect(Object.isFrozen(large)).toBe(true);
    expect(cache.get("large")).toBeNull();
    expect(cache.snapshot()).toMatchObject({ entries: 1, bytes: 200 });
  });

  test("remembering an id again does not count its bytes twice", () => {
    const cache = new ManifestCache();
    cache.remember("same", manifestOf("same"), 100);
    cache.remember("same", manifestOf("same"), 100);
    expect(cache.snapshot()).toMatchObject({ entries: 1, bytes: 200 });
    cache.forget("same");
    expect(cache.snapshot()).toMatchObject({ entries: 0, bytes: 0 });
  });
});
