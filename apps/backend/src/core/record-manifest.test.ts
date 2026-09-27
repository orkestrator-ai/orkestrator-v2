import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  RecordManifestStore,
  type ManifestRead,
  type RecordManifestStoreOptions,
} from "./record-manifest.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function tempDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-record-manifest-"));
  directories.push(directory);
  return directory;
}

const never = () => new Promise<never>(() => undefined);

function manifestStore(
  directory: string,
  overrides: Partial<RecordManifestStoreOptions> = {},
): RecordManifestStore {
  return new RecordManifestStore({
    directory,
    namespace: "transcripts/v1",
    schema: "transcript-test-v1",
    retentionClass: "durable",
    maxChunkBytes: 1_024,
    maxChunksPerRecord: 8,
    maxRecords: 16,
    maxTotalBytes: 64 * 1_024,
    ...overrides,
  });
}

function text(read: ManifestRead): string[] {
  return read.status === "found" ? read.chunks.map((chunk) => chunk.toString()) : [];
}

async function chunkFiles(directory: string): Promise<string[]> {
  return (await fs.readdir(path.join(directory, "chunks"))).filter((name) =>
    name.endsWith(".chunk"),
  );
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  if (!condition()) throw new Error("condition not reached");
}

describe("RecordManifestStore", () => {
  test("commits chunks before the manifest and reuses unchanged chunks", async () => {
    const directory = await tempDirectory();
    const store = manifestStore(directory);
    const first = await store.commit("pipeline-1", [Buffer.from("m1"), Buffer.from("m2")], {
      meta: { complete: false },
    });
    expect(first).toMatchObject({ status: "written", revision: 1 });
    const loaded = await store.readManifest("pipeline-1");
    const [firstChunk] = loaded!.manifest.chunks;
    const firstInode = (await fs.stat(path.join(directory, "chunks", firstChunk!.name))).ino;
    for (const name of await chunkFiles(directory)) {
      expect((await fs.stat(path.join(directory, "chunks", name))).mode & 0o777).toBe(0o600);
    }

    const appended = await store.commit("pipeline-1", [
      ...loaded!.manifest.chunks,
      Buffer.from("m3"),
    ]);
    expect(appended).toMatchObject({ status: "written", revision: 2 });
    // The unchanged chunk was referenced, not rewritten.
    expect((await fs.stat(path.join(directory, "chunks", firstChunk!.name))).ino).toBe(firstInode);
    const read = await store.read("pipeline-1");
    expect(read).toMatchObject({ status: "found", revision: 2, generation: "current" });
    expect(text(read)).toEqual(["m1", "m2", "m3"]);
    expect((await store.readManifest("pipeline-1"))?.manifest.meta).toBeUndefined();
  });

  test("rejects unknown chunk references, oversized chunks, and stale revisions", async () => {
    const directory = await tempDirectory();
    const store = manifestStore(directory);
    await store.commit("a", [Buffer.from("owned-by-a")]);
    const foreign = (await store.readManifest("a"))!.manifest.chunks[0]!;
    expect(await store.commit("b", [foreign])).toEqual({
      status: "rejected",
      reason: "unknown-chunk",
    });
    expect(await store.commit("b", [Buffer.alloc(2_048)])).toEqual({
      status: "rejected",
      reason: "chunk-too-large",
    });
    expect(
      await store.commit(
        "b",
        Array.from({ length: 9 }, (_, index) => Buffer.from(`${index}`)),
      ),
    ).toEqual({ status: "rejected", reason: "too-many-chunks" });
    expect(await store.commit("a", [Buffer.from("x")], { expectedRevision: null })).toEqual({
      status: "conflict",
      currentRevision: 1,
    });
    expect(await store.readChunk("b", foreign)).toBeNull();
  });

  test("chunks written without a committed manifest leave the old revision; repair collects them", async () => {
    const directory = await tempDirectory();
    await manifestStore(directory).commit("key", [Buffer.from("old")]);
    let crashed = false;
    void manifestStore(directory, {
      faults: {
        at: (stage) => {
          if (stage !== "after-chunks") return;
          crashed = true;
          return never();
        },
      },
    }).commit("key", [Buffer.from("new-1"), Buffer.from("new-2")]);
    await waitFor(() => crashed);
    const restarted = manifestStore(directory);
    const read = await restarted.read("key");
    expect(read).toMatchObject({ status: "found", revision: 1 });
    expect(text(read)).toEqual(["old"]);
    expect(await chunkFiles(directory)).toHaveLength(3);
    expect((await restarted.repair()).removedChunks).toBe(0);
    const later = manifestStore(directory, { now: () => Date.now() + 120_000 });
    expect((await later.repair()).removedChunks).toBe(2);
    expect(text(await later.read("key"))).toEqual(["old"]);
  });

  test("a committed manifest with interrupted cleanup is readable; repair removes old chunks", async () => {
    const directory = await tempDirectory();
    const options = { retentionClass: "cache" as const };
    await manifestStore(directory, options).commit("key", [Buffer.from("gen-1")]);
    let crashed = false;
    void manifestStore(directory, {
      ...options,
      faults: {
        at: (stage) => {
          if (stage !== "before-cleanup") return;
          crashed = true;
          return never();
        },
      },
    }).commit("key", [Buffer.from("gen-2")]);
    await waitFor(() => crashed);
    const later = manifestStore(directory, { ...options, now: () => Date.now() + 120_000 });
    expect(text(await later.read("key"))).toEqual(["gen-2"]);
    expect(await chunkFiles(directory)).toHaveLength(2);
    expect((await later.repair()).removedChunks).toBe(1);
    expect(text(await later.read("key"))).toEqual(["gen-2"]);
  });

  test("a durable record never mixes revisions and falls back to the validated prior generation", async () => {
    const directory = await tempDirectory();
    const store = manifestStore(directory);
    await store.commit("key", [Buffer.from("a1"), Buffer.from("b1")]);
    await store.commit("key", [Buffer.from("a2"), Buffer.from("b2")]);
    const current = (await store.readManifest("key"))!.manifest.chunks[1]!;
    await fs.writeFile(path.join(directory, "chunks", current.name), "tampered");
    const read = await store.read("key");
    expect(read).toMatchObject({ status: "found", revision: 1, generation: "previous" });
    expect(text(read)).toEqual(["a1", "b1"]);

    const cache = manifestStore(await tempDirectory(), { retentionClass: "cache" });
    await cache.commit("key", [Buffer.from("only")]);
    const chunk = (await cache.readManifest("key"))!.manifest.chunks[0]!;
    await fs.rm(path.join(cache.manifests.directory, "..", "chunks", chunk.name));
    expect(await cache.read("key")).toEqual({ status: "unavailable", reason: "chunk-unreadable" });
  });

  test("a corrupt current manifest cannot rotate away the valid previous chunks", async () => {
    const directory = await tempDirectory();
    const store = manifestStore(directory);
    await store.commit("key", [Buffer.from("first")]);
    await store.commit("key", [Buffer.from("second")]);
    const file = path.join(store.manifests.directory, `${store.manifests.stemFor("key")}.rec`);
    const bytes = await fs.readFile(file);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    await fs.writeFile(file, bytes);
    expect(text(await store.read("key"))).toEqual(["first"]);
    expect(await store.commit("key", [Buffer.from("third")])).toEqual({
      status: "rejected",
      reason: "corrupt-current",
    });
    expect(text(await store.read("key"))).toEqual(["first"]);
    const later = manifestStore(directory, { now: () => Date.now() + 120_000 });
    await later.repair();
    expect(text(await later.read("key"))).toEqual(["first"]);
  });

  test("repair keeps previous chunks when the durable current header is unindexed", async () => {
    const directory = await tempDirectory();
    const store = manifestStore(directory);
    await store.commit("key", [Buffer.from("first")]);
    await store.commit("key", [Buffer.from("second")]);
    const file = path.join(store.manifests.directory, `${store.manifests.stemFor("key")}.rec`);
    await fs.writeFile(file, "bad header\n");
    const later = manifestStore(directory, { now: () => Date.now() + 120_000 });
    const report = await later.repair();
    expect(report.complete).toBe(false);
    expect(text(await later.read("key"))).toEqual(["first"]);
  });

  test("deletes every manifest generation and the chunks they reference", async () => {
    const directory = await tempDirectory();
    const store = manifestStore(directory);
    await store.commit("key", [Buffer.from("one")]);
    await store.commit("key", [Buffer.from("two")]);
    await store.commit("other", [Buffer.from("keep")]);
    expect(await store.delete("key", { tombstone: true })).toBe(true);
    expect(await store.read("key")).toEqual({ status: "missing" });
    expect(await chunkFiles(directory)).toHaveLength(1);
    expect(text(await store.read("other"))).toEqual(["keep"]);
    expect(await store.manifests.tombstones.isTombstoned(store.manifests.stemFor("key"))).toBe(
      true,
    );
  });
});
