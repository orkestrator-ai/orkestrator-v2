/**
 * ST-20: an hourly retention pass keeps the store's byte count instead of
 * walking for it, takes manifests' objects from a bounded reachability cache
 * instead of reparsing them, and sweeps without holding the store lock across
 * the walk, while a renewed fence still keeps its object.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Manifest } from "./capture.js";
import { ObjectStore, type ObjectStoreOptions } from "./object-store.js";
import { ReachabilityCache } from "./reachability-cache.js";
import { ChangeRetentionService } from "./retention.js";
import { createHarness, type Harness } from "./service-test-support.js";

const directories: string[] = [];
const harnesses: Harness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.cleanup();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const GRACE_MS = 60_000;
const encode = (text: string) => new TextEncoder().encode(text);
const old = () => new Date(Date.now() - 10 * GRACE_MS);

function openStore(options: Partial<ObjectStoreOptions> = {}): ObjectStore {
  const root = mkdtempSync(join(tmpdir(), "ork-retention-walks-"));
  directories.push(root);
  return new ObjectStore({ root, durable: false, ...options });
}

function harness(): Harness {
  const h = createHarness({ repo: false, policy: { orphanGraceMs: GRACE_MS } });
  harnesses.push(h);
  return h;
}

function objectFile(store: ObjectStore, id: string): string {
  return join(store.root, "objects", id.slice(0, 2), id.slice(2));
}

function age(store: ObjectStore, id: string): void {
  utimesSync(objectFile(store, id), old(), old());
}

/** Old, unreachable blobs: everything a sweep may remove. */
async function oldBlobs(store: ObjectStore, count: number, tag = "blob"): Promise<string[]> {
  const batch = store.batch();
  const ids: string[] = [];
  for (let index = 0; index < count; index++)
    ids.push((await batch.put("blob", encode(`${tag} ${index}\n`))).id);
  await batch.flush();
  await batch.close();
  for (const id of ids) age(store, id);
  return ids;
}

/** Run `action` inside the store's next lock hold, before that hold's own work. */
function beforeFirstHold(store: ObjectStore, action: () => void): void {
  const locked = store as unknown as {
    exclusive: (work: () => Promise<unknown>) => Promise<unknown>;
  };
  const exclusive = locked.exclusive.bind(store);
  let armed = true;
  locked.exclusive = (work) =>
    exclusive(async () => {
      if (armed) {
        armed = false;
        action();
      }
      return work();
    });
}

let snapshotSeq = 0;

/** A referenced snapshot whose manifest names `blobs`. */
async function snapshotOf(h: Harness, blobs: readonly string[]): Promise<string> {
  const manifest: Manifest = {
    v: 1,
    root: "walks",
    entries: blobs
      .map((o, index) => ({ p: `u:f${index}`, m: "100644" as const, o, s: 1, t: 1 as const }))
      .toSorted((left, right) => Buffer.compare(Buffer.from(left.p), Buffer.from(right.p))),
    omitted: [],
    unstable: [],
  };
  const { id: tree } = await h.service.objects.put("manifest", encode(JSON.stringify(manifest)));
  const id = `walks-${++snapshotSeq}`;
  const at = new Date(Date.now() - 10 * GRACE_MS).toISOString();
  h.service.ledger.insertSnapshot({
    id,
    worktree_id: "w",
    incarnation: "i",
    tree_oid: tree,
    object_format: "sha1",
    policy_id: "p",
    capture_started_at: at,
    capture_finished_at: at,
    observation_epoch: 0,
    coverage_json: "{}",
    consistency_json: "{}",
    closure_verified: 1,
    file_count: blobs.length,
    retained_bytes: 0,
    created_at: at,
  });
  h.service.ledger.addReference({
    ownerKind: "test",
    ownerId: id,
    snapshotId: id,
    reason: "test",
  });
  age(h.service.objects, tree);
  return tree;
}

describe("the store's byte count", () => {
  test("stays exact across puts and sweeps without another walk", async () => {
    const store = openStore();
    const removable = await oldBlobs(store, 12, "removable");
    await store.put("blob", encode("kept\n"));
    const walks = spyOn(store, "storedBytes");
    const before = await store.currentBytes();
    expect(walks).toHaveBeenCalledTimes(0); // the puts already counted
    const swept = await store.sweep(new Set(), GRACE_MS);
    expect(swept.removed).toBe(removable.length);
    await store.put("blob", encode("after the sweep\n"));
    const after = await store.currentBytes();
    expect(walks).toHaveBeenCalledTimes(0);
    walks.mockRestore();
    expect(after).toBe(await store.storedBytes());
    expect(after).toBeLessThan(before);
  });

  test("walks once when no figure exists, and again after an outside deletion", async () => {
    const first = openStore();
    for (const text of ["a\n", "b\n", "c\n"]) await first.put("blob", encode(text));
    const store = new ObjectStore({ root: first.root, durable: false });
    const walks = spyOn(store, "storedBytes");
    expect(await store.currentBytes()).toBe(await first.storedBytes());
    expect(await store.currentBytes()).toBe(await first.storedBytes());
    expect(walks).toHaveBeenCalledTimes(1);

    // Deleted by something else between the sweep's walk and its removal.
    const [victim] = await oldBlobs(store, 1, "victim");
    beforeFirstHold(store, () => unlinkSync(objectFile(store, victim!)));
    expect((await store.sweep(new Set(), GRACE_MS)).removed).toBe(0);
    walks.mockClear();
    expect(await store.currentBytes()).toBe(await first.storedBytes());
    expect(walks).toHaveBeenCalledTimes(1);
  });

  test.each(["reachable", "young"])(
    "daily reconciliation counts outside changes to %s objects",
    async (kind) => {
      const h = harness();
      const store = h.service.objects;
      const { id } = await store.put("blob", encode("externally removed"));
      if (kind === "reachable") await snapshotOf(h, [id]);
      await h.service.retention.run();
      const originalBytes = await store.currentBytes();
      const source = openStore();
      const added = await source.put("blob", encode("externally added"));
      const target = objectFile(store, added.id);
      mkdirSync(join(store.root, "objects", added.id.slice(0, 2)), { recursive: true });
      copyFileSync(objectFile(source, added.id), target);
      unlinkSync(objectFile(store, id));
      // Neither object is a sweep candidate: one was removed before enumeration,
      // the other is young. No immediate recount is required for unseen changes.
      expect(await store.currentBytes()).toBe(originalBytes);
      const now = Date.now();
      const clock = spyOn(Date, "now").mockReturnValue(now + 24 * 60 * 60 * 1000);
      try {
        const report = await h.service.retention.run(now); // keep the new object's grace fence
        const actual = await store.storedBytes();
        expect(report.storedBytes).toBe(actual);
        expect(await store.currentBytes()).toBe(actual);
        expect((await h.service.retention.run(now)).storedBytes).toBe(actual);
      } finally {
        clock.mockRestore();
      }
    },
  );

  test("a put reconciles an externally inflated hard-budget count after a day", async () => {
    let budget = 100;
    const store = openStore({ hardBudgetBytes: () => budget });
    const { id } = await store.put("blob", encode("old"));
    budget = await store.currentBytes();
    unlinkSync(objectFile(store, id));
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 24 * 60 * 60 * 1000);
    try {
      await store.put("blob", encode("new"));
      expect(await store.currentBytes()).toBe(await store.storedBytes());
    } finally {
      clock.mockRestore();
    }
  });

  test("a retention pass reads the figure instead of walking the store", async () => {
    const h = harness();
    await snapshotOf(h, await oldBlobs(h.service.objects, 5));
    await oldBlobs(h.service.objects, 3, "orphan");
    await h.service.retention.run();
    const walks = spyOn(h.service.objects, "storedBytes");
    const report = await h.service.retention.run();
    expect(walks).toHaveBeenCalledTimes(0);
    walks.mockRestore();
    expect(report.storedBytes).toBe(await h.service.objects.storedBytes());
  });
});

describe("a sweep's lock", () => {
  test("a capture's write finishes while a long sweep is still walking", async () => {
    // The sweep is held mid-walk, after its first removal released the lock,
    // until the put has finished. This used to rely on 1,500 old blobs making
    // the walk outlast the put, and creating and ageing them alone took most of
    // the 5 s deadline on a loaded host (case 5822). A sweep that held the lock
    // across its walk would block the put here; the bound below then lets it
    // finish first, so the order assertion fails instead of the test hanging.
    const store = openStore();
    const blobs = await oldBlobs(store, 2 * 64);
    const prefixes = new Set(blobs.map((id) => id.slice(0, 2)));
    expect(prefixes.size).toBeGreaterThan(1);
    const locked = store as unknown as {
      exclusive: (work: () => Promise<unknown>) => Promise<unknown>;
    };
    const exclusive = locked.exclusive.bind(store);
    let midWalk!: () => void;
    const reachedMidWalk = new Promise<void>((resolve) => (midWalk = resolve));
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => (resume = resolve));
    let first = true;
    locked.exclusive = (work) => {
      const held = exclusive(work);
      if (!first) return held;
      first = false;
      return held.then(async (value) => {
        midWalk();
        await resumed;
        return value;
      });
    };
    const order: string[] = [];
    const sweeping = store.sweep(new Set(), GRACE_MS).then((swept) => {
      order.push("sweep");
      return swept;
    });
    await reachedMidWalk;
    const put = store.put("blob", encode("written during the sweep\n")).then(() => {
      order.push("put");
    });
    await Promise.race([put, Bun.sleep(10_000)]);
    // Still walking: the put finished while most old blobs were not yet removed.
    const remaining = blobs.filter((id) => existsSync(objectFile(store, id))).length;
    resume();
    const swept = await sweeping;
    await put;
    expect(order).toEqual(["put", "sweep"]);
    expect(remaining).toBeGreaterThan(blobs.length / 2);
    expect(swept.removed).toBe(blobs.length);
  });

  test("a fence renewed after the walk saw it old keeps the object", async () => {
    const store = openStore();
    const [renewed, ...others] = await oldBlobs(store, 3);
    // The walk runs without the lock; the first hold after it is the removal.
    // A renewal queued in between runs first, as `reuse` would.
    beforeFirstHold(store, () => {
      const now = new Date();
      utimesSync(objectFile(store, renewed!), now, now);
    });
    const swept = await store.sweep(new Set(), GRACE_MS);
    expect(await store.has(renewed!)).toBe(true);
    for (const id of others) expect(await store.has(id)).toBe(false);
    expect(swept.removed).toBe(others.length);
  });

  test("a removal that wins the lock makes a queued reuse report the object gone", async () => {
    const store = openStore({ orphanGraceMs: () => GRACE_MS });
    const [id] = await oldBlobs(store, 1);
    let reused: Promise<boolean> | undefined;
    // Queue reuse from inside the removal hold: it must wait until removal
    // finishes, even though the file still exists when reuse is requested.
    beforeFirstHold(store, () => {
      reused = store.reuse(id!);
    });
    expect((await store.sweep(new Set(), GRACE_MS)).removed).toBe(1);
    expect(reused).toBeDefined();
    expect(await reused).toBe(false);
    expect(await store.has(id!)).toBe(false);
    expect(await store.currentBytes()).toBe(await store.storedBytes());
  });

  test("reuse during a sweep either keeps the object or reports it gone", async () => {
    const store = openStore({ orphanGraceMs: () => GRACE_MS });
    const ids = await oldBlobs(store, 600);
    const sweeping = store.sweep(new Set(), GRACE_MS);
    const reused = await Promise.all(ids.map((id) => store.reuse(id)));
    await sweeping;
    for (const [index, id] of ids.entries())
      if (reused[index]) expect(await store.has(id)).toBe(true);
    // The renewals queued before the removals reached them.
    expect(reused.some(Boolean)).toBe(true);
  });
});

describe("reachability between passes", () => {
  test("a second pass parses no manifest and keeps exactly what a cold walk keeps", async () => {
    const h = harness();
    const store = h.service.objects;
    const kept = await oldBlobs(store, 6, "kept");
    const trees = [await snapshotOf(h, kept.slice(0, 4)), await snapshotOf(h, kept.slice(2))];
    await h.service.retention.run();
    const orphans = await oldBlobs(store, 4, "orphan");
    const parses = store.manifests.snapshot().parses;
    const report = await h.service.retention.run();
    expect(store.manifests.snapshot().parses).toBe(parses);
    expect(h.service.retention.reachabilityStats().hits).toBe(trees.length);
    expect(report.removedObjects).toBe(orphans.length);
    for (const id of [...kept, ...trees]) expect(await store.has(id)).toBe(true);
    for (const id of orphans) expect(await store.has(id)).toBe(false);
  });

  test("snapshots of one tree read its manifest once per pass", async () => {
    const h = harness();
    const blobs = await oldBlobs(h.service.objects, 3);
    await snapshotOf(h, blobs);
    await snapshotOf(h, blobs);
    await snapshotOf(h, blobs);
    const retention = new ChangeRetentionService({
      ledger: h.service.ledger,
      store: h.service.objects,
      policies: h.service.policies,
      readerPins: () => [],
      reachabilityCache: { maxEntries: 0 },
    });
    const parses = h.service.objects.manifests.snapshot().parses;
    await retention.run();
    expect(h.service.objects.manifests.snapshot().parses - parses).toBe(1);
  });

  test("a cached manifest that is gone contributes nothing, as a read would", async () => {
    const h = harness();
    const store = h.service.objects;
    const blobs = await oldBlobs(store, 3);
    const tree = await snapshotOf(h, blobs);
    await h.service.retention.run();
    for (const id of blobs) expect(await store.has(id)).toBe(true);
    unlinkSync(objectFile(store, tree));
    const report = await h.service.retention.run();
    expect(report.removedObjects).toBe(blobs.length);
    expect(h.service.retention.reachabilityStats().entries).toBe(0);
    expect(report.storedBytes).toBe(0);
    expect(report.storedBytes).toBe(await store.storedBytes());
    expect(await store.currentBytes()).toBe(await store.storedBytes());
    expect((await h.service.retention.run()).storedBytes).toBe(await store.storedBytes());
    expect(await store.currentBytes()).toBe(await store.storedBytes());
  });

  test("a full cache admits nothing new and a cold manifest is still walked", async () => {
    const h = harness();
    const store = h.service.objects;
    const first = await oldBlobs(store, 2, "first");
    const second = await oldBlobs(store, 2, "second");
    await snapshotOf(h, first);
    await snapshotOf(h, second);
    const retention = new ChangeRetentionService({
      ledger: h.service.ledger,
      store,
      policies: h.service.policies,
      readerPins: () => [],
      reachabilityCache: { maxEntries: 1 },
    });
    await retention.run();
    expect(retention.reachabilityStats().entries).toBe(1);
    await retention.run();
    expect(retention.reachabilityStats().hits).toBe(1);
    for (const id of [...first, ...second]) expect(await store.has(id)).toBe(true);
  });
});

describe("ReachabilityCache", () => {
  const oid = (n: number) => n.toString(16).padStart(40, "0");

  test("round-trips ids and is bounded by bytes", () => {
    const cache = new ReachabilityCache({ maxBytes: 3 * 20 });
    cache.beginPass();
    cache.remember("m1", [oid(1), oid(2)]);
    cache.remember("m2", [oid(3), oid(4)]); // would exceed the byte bound
    const reachable = new Set<string>();
    expect(cache.addTo("m1", reachable)).toBe(true);
    expect(cache.addTo("m2", reachable)).toBe(false);
    expect([...reachable]).toEqual([oid(1), oid(2)]);
    expect(cache.snapshot()).toEqual({ entries: 1, bytes: 40 });
  });

  test("a pass drops what it did not walk, which frees room for new trees", () => {
    const cache = new ReachabilityCache({ maxEntries: 1 });
    cache.beginPass();
    cache.remember("old", [oid(1)]);
    cache.endPass();
    cache.beginPass();
    cache.remember("new", [oid(2)]); // full: not admitted this pass
    cache.endPass(); // "old" was not walked, so it goes
    expect(cache.snapshot().entries).toBe(0);
    cache.beginPass();
    cache.remember("new", [oid(2)]);
    cache.endPass();
    expect(cache.addTo("new", new Set())).toBe(true);
  });

  test("ids that are not full lowercase hex are not cached", () => {
    const cache = new ReachabilityCache();
    cache.beginPass();
    cache.remember("odd", [oid(1), "not-an-oid"]);
    expect(cache.addTo("odd", new Set())).toBe(false);
    expect(cache.snapshot()).toEqual({ entries: 0, bytes: 0 });
  });
});
