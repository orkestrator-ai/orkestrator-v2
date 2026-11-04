/**
 * ST-6: compression and fsync leave the event loop, fsyncs are grouped per
 * capture, and durability does not weaken: no name exists before its content is
 * synced, and nothing is reported safe to name before its directory is synced.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import {
  captureWorktree,
  HostCaptureExecutor,
  type CaptureExecutor,
  type CaptureResult,
} from "./capture.js";
import {
  BATCH_MAX_BYTES,
  BATCH_MAX_OBJECTS,
  ObjectStore,
  objectId,
  OFF_LOOP_ZLIB_BYTES,
  type ObjectStoreOptions,
  type SyncPath,
} from "./object-store.js";
import { createHarness } from "./service-test-support.js";

const directories: string[] = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

const encode = (text: string) => new TextEncoder().encode(text);

function repoWith(files: Record<string, string | Uint8Array>): string {
  const repo = temp("ork-write-repo-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(repo, name), content);
  return repo;
}

function captured(result: CaptureResult) {
  if (result.kind !== "captured") throw new Error(`capture failed: ${result.reason}`);
  return result;
}

interface SyncEvent {
  path: string;
  kind: "file" | "directory";
  /** A file's object id, taken from its temporary name. */
  id: string | null;
  /** For a file: whether its final name already existed when it was synced. */
  namedAlready: boolean;
}

/** A store that records every fsync it would have made. */
function recordingStore(options: Partial<ObjectStoreOptions> & { root?: string } = {}) {
  const events: SyncEvent[] = [];
  const root = options.root ?? temp("ork-write-store-");
  const sync: SyncPath = async (path, kind) => {
    const id = kind === "file" ? basename(path).split(".")[0]! : null;
    events.push({
      path,
      kind,
      id,
      namedAlready: id ? existsSync(join(root, "objects", id.slice(0, 2), id.slice(2))) : false,
    });
  };
  const store = new ObjectStore({ durable: true, fsync: sync, ...options, root });
  return { store, events };
}

function objectFile(store: ObjectStore, id: string): string {
  return join(store.root, "objects", id.slice(0, 2), id.slice(2));
}

const tempFiles = (store: ObjectStore) => readdirSync(join(store.root, "tmp"));

function objectNames(store: ObjectStore): string[] {
  const objects = join(store.root, "objects");
  return readdirSync(objects)
    .filter((prefix) => /^[0-9a-f]{2}$/.test(prefix))
    .flatMap((prefix) => readdirSync(join(objects, prefix)).map((name) => `${prefix}${name}`));
}

async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

describe("a put's durability", () => {
  test("names an object only after its content is synced, and syncs the name before returning", async () => {
    const { store, events } = recordingStore();
    const { id, created } = await store.put("blob", encode("durable\n"));
    expect(created).toBe(true);
    const file = events.find((event) => event.kind === "file");
    expect(file).toMatchObject({ id, namedAlready: false });
    const directory = events.findIndex(
      (event) => event.kind === "directory" && event.path === dirname(objectFile(store, id)),
    );
    expect(directory).toBeGreaterThan(events.indexOf(file!));
    expect(events.map((event) => event.path)).toContain(join(store.root, "objects"));
    expect(new TextDecoder().decode((await store.get(id))!)).toBe("durable\n");
    expect(tempFiles(store)).toEqual([]);
  });

  test("works against the real filesystem, directories included", async () => {
    const store = new ObjectStore({ root: temp("ork-write-store-"), durable: true });
    const large = randomBytes(OFF_LOOP_ZLIB_BYTES * 2);
    const { id } = await store.put("blob", large);
    expect(Buffer.compare(Buffer.from((await store.get(id))!), large)).toBe(0);
    expect(lstatSync(objectFile(store, id)).mode & 0o777).toBe(0o400);
  });

  test("two writers of the same content converge on one object", async () => {
    const { store } = recordingStore();
    const bytes = randomBytes(OFF_LOOP_ZLIB_BYTES * 2);
    const [first, second] = await Promise.all([store.put("blob", bytes), store.put("blob", bytes)]);
    expect(second.id).toBe(first.id);
    expect(await store.get(first.id)).not.toBeNull();
    expect(tempFiles(store)).toEqual([]);
    const before = await store.storedBytes();
    await store.put("blob", bytes);
    expect(await store.storedBytes()).toBe(before);
  });

  test("a corrupt large object reads as absent through the off-loop path", async () => {
    const store = new ObjectStore({ root: temp("ork-write-store-"), durable: false });
    const { id } = await store.put("blob", randomBytes(OFF_LOOP_ZLIB_BYTES * 2));
    rmSync(objectFile(store, id), { force: true });
    writeFileSync(objectFile(store, id), randomBytes(OFF_LOOP_ZLIB_BYTES * 2));
    expect(await store.get(id)).toBeNull();
  });
});

describe("a batch", () => {
  test("gives a staged object no final name, and no fsync, until the flush", async () => {
    const { store, events } = recordingStore();
    const batch = store.batch();
    const { id, created } = await batch.put("blob", encode("staged\n"));
    expect(created).toBe(true);
    expect(await store.has(id)).toBe(false);
    expect(await store.reuse(id)).toBe(false);
    expect(await store.get(id)).toBeNull();
    expect(tempFiles(store)).toHaveLength(1);
    expect(events).toEqual([]);

    await batch.flush();
    expect(await store.has(id)).toBe(true);
    expect(tempFiles(store)).toEqual([]);
    await batch.close();
  });

  test("stores content repeated within a batch once", async () => {
    const { store, events } = recordingStore();
    const batch = store.batch();
    const first = await batch.put("blob", encode("twice\n"));
    const second = await batch.put("blob", encode("twice\n"));
    expect([first.created, second.created]).toEqual([true, false]);
    await batch.flush();
    expect(events.filter((event) => event.kind === "file")).toHaveLength(1);
    await batch.close();
  });

  test("syncs many objects concurrently, and each directory once", async () => {
    let running = 0;
    let peak = 0;
    const events: Array<{ path: string; kind: string }> = [];
    const store = new ObjectStore({
      root: temp("ork-write-store-"),
      durable: true,
      fsync: async (path, kind) => {
        events.push({ path, kind });
        running++;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 1));
        running--;
      },
    });
    const batch = store.batch();
    const ids: string[] = [];
    for (let index = 0; index < 64; index++)
      ids.push((await batch.put("blob", encode(`object ${index}\n`))).id);
    expect(events).toEqual([]);
    await batch.flush();
    expect(events.filter((event) => event.kind === "file")).toHaveLength(64);
    expect(peak).toBeGreaterThan(1);
    const synced = events.filter((event) => event.kind === "directory").map((event) => event.path);
    expect(new Set(synced).size).toBe(synced.length);
    for (const id of ids) expect(synced).toContain(dirname(objectFile(store, id)));
    await batch.close();
  });

  test("flushes itself at its object bound, so its temporaries stay bounded", async () => {
    const { store, events } = recordingStore();
    const batch = store.batch();
    let highest = 0;
    for (let index = 0; index < BATCH_MAX_OBJECTS + 1; index++) {
      await batch.put("blob", encode(`bound ${index}\n`));
      highest = Math.max(highest, tempFiles(store).length);
    }
    expect(highest).toBeLessThan(BATCH_MAX_OBJECTS);
    expect(events.filter((event) => event.kind === "file")).toHaveLength(BATCH_MAX_OBJECTS);
    await batch.close();
    expect(tempFiles(store)).toEqual([]);
  });

  test("flushes at the compressed byte bound below the object-count bound", async () => {
    const { store, events } = recordingStore();
    const batch = store.batch();
    const ids: string[] = [];
    // Incompressible inputs cross 64 MiB with four objects, far below 512.
    const size = BATCH_MAX_BYTES / 4;
    for (let index = 0; index < 3; index++)
      ids.push((await batch.put("blob", randomBytes(size))).id);
    expect(events).toEqual([]);
    expect(tempFiles(store)).toHaveLength(3);
    ids.push((await batch.put("blob", randomBytes(size))).id);
    expect(events.filter((event) => event.kind === "file")).toHaveLength(4);
    expect(tempFiles(store)).toEqual([]);
    for (const id of ids) expect(await store.has(id)).toBe(true);
    const tail = await batch.put("blob", encode("after byte flush\n"));
    expect(await store.has(tail.id)).toBe(false);
    await batch.close();
    expect(await store.has(tail.id)).toBe(true);
    expect(tempFiles(store)).toEqual([]);
  });

  test("charges staged bytes against the hard budget and releases them on discard", async () => {
    let failing = true;
    const { store } = recordingStore({
      hardBudgetBytes: () => 24 * 1024,
      fsync: async () => {
        if (failing) throw Object.assign(new Error("io"), { code: "EIO" });
      },
    });
    const batch = store.batch();
    await batch.put("blob", randomBytes(16 * 1024));
    await expect(batch.put("blob", randomBytes(16 * 1024))).rejects.toThrow(
      "capture-storage-quota",
    );
    await batch.close(); // cannot publish, so it discards
    expect(tempFiles(store)).toEqual([]);
    failing = false;
    await store.put("blob", randomBytes(16 * 1024));
  });

  test("a sweep leaves a live batch's temporaries and takes abandoned ones", async () => {
    const root = temp("ork-write-store-");
    const crashed = new ObjectStore({ root, durable: false });
    await crashed.batch().put("blob", encode("abandoned by a crash\n"));
    const [abandoned] = readdirSync(join(root, "tmp"));

    const store = new ObjectStore({ root, durable: false });
    const batch = store.batch();
    const { id } = await batch.put("blob", encode("still staged\n"));
    const old = new Date(Date.now() - 120_000);
    for (const name of readdirSync(join(root, "tmp")))
      utimesSync(join(root, "tmp", name), old, old);

    await store.sweep(new Set(), 60_000);
    expect(readdirSync(join(root, "tmp"))).not.toContain(abandoned);
    expect(readdirSync(join(root, "tmp"))).toHaveLength(1);
    await batch.flush();
    expect(await store.has(id)).toBe(true);
  });

  for (const recover of [true, false]) {
    test(`a mid-chunk rename failure ${recover ? "retries remaining objects" : "discards remaining objects on close"} and retains pending directory syncs`, async () => {
      let budget = Infinity;
      const { store, events } = recordingStore({ hardBudgetBytes: () => budget });
      // Clear initialization syncs so the later flush must remember the name
      // placed before the rename failure, rather than just syncing startup.
      await store.batch().flush();
      events.length = 0;
      const batch = store.batch();
      const payloads = ["placed before failure\n", "blocked rename\n", "after failure\n"];
      const ids: string[] = [];
      for (const payload of payloads) ids.push((await batch.put("blob", encode(payload))).id);
      expect(new Set(ids.map((id) => id.slice(0, 2))).size).toBe(3);
      const [first, blocked, last] = ids as [string, string, string];
      const stagedNames = tempFiles(store);
      // A file in place of the fan-out directory makes the real rename fail
      // with ENOTDIR (not the ENOENT path that creates a missing directory).
      const obstruction = dirname(objectFile(store, blocked));
      writeFileSync(obstruction, "obstruction");
      try {
        await expect(batch.flush()).rejects.toMatchObject({ code: "ENOTDIR" });
        expect(await store.get(first)).toEqual(encode(payloads[0]!));
        expect(await store.has(blocked)).toBe(false);
        expect(await store.has(last)).toBe(false);
        const remaining = tempFiles(store);
        expect(remaining.map((name) => name.split(".")[0]).toSorted()).toEqual(
          [blocked, last].toSorted(),
        );
        expect(events.filter((event) => event.kind === "directory")).toEqual([]);

        const old = new Date(Date.now() - 120_000);
        for (const name of remaining) utimesSync(join(store.root, "tmp", name), old, old);
        await store.sweep(new Set(ids), 60_000);
        expect(tempFiles(store).toSorted()).toEqual(remaining.toSorted());

        events.length = 0;
        if (recover) {
          rmSync(obstruction);
          await batch.flush();
          for (const [index, id] of ids.entries())
            expect(await store.get(id)).toEqual(encode(payloads[index]!));
          expect(
            events
              .filter((event) => event.kind === "file")
              .map((event) => event.id)
              .toSorted(),
          ).toEqual([blocked, last].toSorted());
        } else {
          await batch.close(); // the rename still fails; close discards its tail
          expect(await store.get(blocked)).toBeNull();
          expect(await store.get(last)).toBeNull();
          expect(events.filter((event) => event.kind === "directory")).toEqual([]);
          rmSync(obstruction);
          await store.batch().flush();
        }
        expect(tempFiles(store)).toEqual([]);
        const synced = events
          .filter((event) => event.kind === "directory")
          .map((event) => event.path);
        expect(synced).toContain(dirname(objectFile(store, first)));
        expect(synced).toContain(join(store.root, "objects"));

        // Released names must no longer be protected as live staged temps.
        for (const name of stagedNames) {
          const path = join(store.root, "tmp", name);
          writeFileSync(path, "abandoned");
          utimesSync(path, old, old);
        }
        await store.sweep(new Set(ids), 60_000);
        expect(tempFiles(store)).toEqual([]);

        // Exactly enough headroom for one new object proves reservations from
        // both the placed prefix and the retried/discarded tail were released.
        const probe = encode("quota after rename failure\n");
        budget =
          (await store.storedBytes()) +
          deflateSync(Buffer.concat([Buffer.from(`blob ${probe.length}\0`), probe])).length;
        await store.put("blob", probe);
      } finally {
        if (existsSync(obstruction) && lstatSync(obstruction).isFile()) rmSync(obstruction);
        await batch.close();
      }
    });
  }
});

describe("a capture's durability", () => {
  test("syncs every new object it names, grouped at the end, before it returns", async () => {
    const repo = repoWith({ "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" });
    const { store, events } = recordingStore();
    const put = spyOn(store, "put");
    const result = captured(
      await captureWorktree({ executor: new HostCaptureExecutor(repo), store }),
    );
    // Nothing goes through the one-object-at-a-time path.
    expect(put).not.toHaveBeenCalled();

    const names = [result.manifestId, ...result.manifest.entries.map((entry) => entry.o)];
    const fileSyncs = events.filter((event) => event.kind === "file");
    expect(fileSyncs.map((event) => event.id).toSorted()).toEqual(names.toSorted());
    for (const event of fileSyncs) expect(event.namedAlready).toBe(false);
    const directorySyncs = events.filter((event) => event.kind === "directory");
    for (const id of names)
      expect(directorySyncs.map((event) => event.path)).toContain(dirname(objectFile(store, id)));
    // Group commit: at most one sync per directory, all after the file syncs.
    const paths = directorySyncs.map((event) => event.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(events.indexOf(directorySyncs[0]!)).toBeGreaterThan(events.indexOf(fileSyncs.at(-1)!));
  });

  test("does not return while a directory sync is still running", async () => {
    const repo = repoWith({ "a.txt": "a\n" });
    const gate = deferred();
    let reached = false;
    const store = new ObjectStore({
      root: temp("ork-write-store-"),
      durable: true,
      fsync: async (_path, kind) => {
        if (kind !== "directory") return;
        reached = true;
        await gate.promise;
      },
    });
    let returned = false;
    const capture = captureWorktree({ executor: new HostCaptureExecutor(repo), store }).then(
      (result) => {
        returned = true;
        return result;
      },
    );
    await waitFor(() => reached);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(returned).toBe(false);
    gate.resolve();
    captured(await capture);
  });

  test("a warm capture over unchanged settled files syncs no object", async () => {
    const repo = repoWith({ "a.txt": "a\n", "b.txt": "b\n" });
    const { store, events } = recordingStore();
    const executor = new HostCaptureExecutor(repo, 0);
    const first = captured(await captureWorktree({ executor, store }));
    events.length = 0;
    const second = captured(
      await captureWorktree({
        executor,
        store,
        previous: first.manifest,
        statCache: first.statCache,
      }),
    );
    expect(second.manifestId).toBe(first.manifestId);
    expect(events).toEqual([]);
  });

  test("the ledger row is written only after the objects it names are synced", async () => {
    const h = createHarness();
    cleanups.push(() => h.cleanup());
    const events: SyncEvent[] = [];
    const store = h.service.objects;
    // The service's store, turned durable with its sync observed.
    Object.assign(store, {
      durable: true,
      sync: (async (path, kind) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        events.push({ path, kind, id: basename(path).split(".")[0]!, namedAlready: false });
      }) satisfies SyncPath,
    });
    writeFileSync(join(h.repo, "new.txt"), "named by the ledger\n");

    const seen: Array<{ pendingFiles: string[]; pendingDirectories: string[] }> = [];
    const original = h.service.ledger.insertSnapshot.bind(h.service.ledger);
    const insert = spyOn(h.service.ledger, "insertSnapshot").mockImplementation((row) => {
      const manifest = store.manifests.get(row.tree_oid);
      if (!manifest) throw new Error("the capture should have cached its manifest");
      const named = [row.tree_oid, ...manifest.entries.map((entry) => entry.o)];
      const files = new Set(events.filter((event) => event.kind === "file").map((e) => e.id));
      const synced = new Set(
        events.filter((event) => event.kind === "directory").map((e) => e.path),
      );
      seen.push({
        pendingFiles: named.filter((id) => !files.has(id)),
        pendingDirectories: named.filter((id) => !synced.has(dirname(objectFile(store, id)))),
      });
      original(row);
    });
    const identity = await h.service.registry.resolve({ kind: "local", worktreePath: h.repo });
    const owner = h.service.registry.owner(identity!);
    const outcome = await owner.capture({ purpose: "provisional", deadlineMs: 30_000 });
    insert.mockRestore();
    expect(outcome.kind).toBe("published");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.pendingFiles).toEqual([]);
    expect(seen[0]!.pendingDirectories).toEqual([]);
  });

  test("waits for a name another writer placed but has not synced yet", async () => {
    const repo = repoWith({ "shared.txt": "shared\n" });
    const shared = objectId("blob", encode("shared\n"));
    const gate = deferred();
    let firstHeld = false;
    const store = new ObjectStore({
      root: temp("ork-write-store-"),
      durable: true,
      fsync: async (path, kind) => {
        if (kind === "directory" && path.endsWith(`/${shared.slice(0, 2)}`) && !firstHeld) {
          firstHeld = true;
          await gate.promise;
        }
      },
    });
    const writer = store.put("blob", encode("shared\n"));
    await waitFor(() => firstHeld);
    expect(await store.has(shared)).toBe(true);

    let returned = false;
    const capture = captureWorktree({ executor: new HostCaptureExecutor(repo), store }).then(
      (result) => {
        returned = true;
        return result;
      },
    );
    // Its own objects are placed, so all it can be waiting for is the sync.
    await waitFor(() => objectNames(store).length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(returned).toBe(false);
    gate.resolve();
    const result = captured(await capture);
    await writer;
    expect(result.manifest.entries[0]?.o).toBe(shared);
  });

  test("a one-shot file sync failure is discarded while healthy objects survive close", async () => {
    const repo = repoWith({ "a.txt": "a\n", "b.txt": "b\n" });
    const victim = objectId("blob", encode("b\n"));
    let failures = 1;
    let victimSyncs = 0;
    const store = new ObjectStore({
      root: temp("ork-write-store-"),
      durable: true,
      fsync: async (path) => {
        if (basename(path).startsWith(victim)) {
          victimSyncs++;
          if (failures-- > 0) throw Object.assign(new Error("io"), { code: "EIO" });
        }
      },
    });
    const executor = new HostCaptureExecutor(repo);
    const failed = await captureWorktree({ executor, store });
    expect(failed).toMatchObject({ kind: "unavailable", reason: "capture-failed" });
    expect(await store.has(victim)).toBe(false);
    expect(tempFiles(store)).toEqual([]);

    expect(await store.get(victim)).toBeNull();
    expect(victimSyncs).toBe(1);
    expect(await store.has(objectId("blob", encode("a\n")))).toBe(true);
    const retried = captured(await captureWorktree({ executor, store }));
    expect(await store.get(victim)).not.toBeNull();
    expect(await store.get(retried.manifestId)).not.toBeNull();
    expect(victimSyncs).toBe(2);
  });

  test("a failed directory sync fails the capture and is retried by the next flush", async () => {
    const repo = repoWith({ "a.txt": "a\n" });
    const blob = objectId("blob", encode("a\n"));
    const fanOut = `/${blob.slice(0, 2)}`;
    let failures = 1;
    const synced: string[] = [];
    const store = new ObjectStore({
      root: temp("ork-write-store-"),
      durable: true,
      fsync: async (path, kind) => {
        if (kind !== "directory") return;
        if (path.endsWith(fanOut) && failures-- > 0)
          throw Object.assign(new Error("io"), { code: "EIO" });
        synced.push(path);
      },
    });
    const executor = new HostCaptureExecutor(repo);
    const failed = await captureWorktree({ executor, store });
    expect(failed).toMatchObject({ kind: "unavailable", reason: "capture-failed" });
    // The name exists, but the capture was not told it is safe to name.
    expect(await store.has(blob)).toBe(true);

    captured(await captureWorktree({ executor, store }));
    expect(synced.filter((path) => path.endsWith(fanOut)).length).toBeGreaterThan(0);
  });

  test("a capture that runs out of time keeps what it wrote, so a retry can finish", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [`f${index}.txt`, `file ${index}\n`]),
    );
    const repo = repoWith(files);
    const { store } = recordingStore();
    const inner = new HostCaptureExecutor(repo);
    const controller = new AbortController();
    let described = 0;
    const interrupted: CaptureExecutor = {
      kind: inner.kind,
      label: inner.label,
      inventory: (limits, signal) => inner.inventory(limits, signal),
      describe: async (pathIds, limits, signal, statCache) => {
        if (++described === 5) controller.abort();
        return inner.describe(pathIds, limits, signal, statCache);
      },
      fetch: (pathIds, limits, signal) => inner.fetch(pathIds, limits, signal),
    };
    const first = await captureWorktree({
      executor: interrupted,
      store,
      signal: controller.signal,
    });
    expect(first).toMatchObject({ kind: "unavailable", reason: "capture-timeout" });
    expect(tempFiles(store)).toEqual([]);
    const kept = await store.storedBytes();
    expect(kept).toBeGreaterThan(0);

    const retried = captured(await captureWorktree({ executor: inner, store }));
    expect(retried.coverage.newObjects).toBeLessThan(9);
    expect(retried.manifest.entries).toHaveLength(8);
  });

  test("a crash mid-capture leaves a store that reads, adopts nothing partial and recovers", async () => {
    const repo = repoWith({ "a.txt": "a\n", "b.txt": "b\n" });
    const root = temp("ork-write-store-");
    const { store: before } = recordingStore({ root });
    const executor = new HostCaptureExecutor(repo);
    const first = captured(await captureWorktree({ executor, store: before }));

    // The process dies with objects staged: temporaries exist, no flush ran.
    const stagedContent = "c, staged when the process died\n";
    const batch = before.batch();
    const staged = await batch.put("blob", encode(stagedContent));
    expect(readdirSync(join(root, "tmp"))).toHaveLength(1);

    const { store, events } = recordingStore({ root });
    await store.init();
    expect(await store.has(staged.id)).toBe(false);
    expect(await store.reuse(staged.id)).toBe(false);
    for (const id of objectNames(store)) expect(await store.get(id)).not.toBeNull();

    writeFileSync(join(repo, "c.txt"), stagedContent);
    const next = captured(await captureWorktree({ executor, store, previous: first.manifest }));
    expect(await store.get(staged.id)).not.toBeNull();
    expect(next.manifest.entries.map((entry) => entry.o)).toContain(staged.id);
    // The new process vouches for names the dead one may not have synced.
    const synced = events.filter((event) => event.kind === "directory").map((event) => event.path);
    for (const entry of first.manifest.entries)
      expect(synced).toContain(dirname(objectFile(store, entry.o)));

    const old = new Date(Date.now() - 120_000);
    for (const name of readdirSync(join(root, "tmp")))
      utimesSync(join(root, "tmp", name), old, old);
    await store.sweep(new Set([next.manifestId, ...next.manifest.entries.map((e) => e.o)]), 60_000);
    expect(readdirSync(join(root, "tmp"))).toEqual([]);
  });
});

/** The longest stretch `work` left timers waiting. */
async function longestStall(work: () => Promise<unknown> | unknown): Promise<number> {
  let last = performance.now();
  let longest = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  }, 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  longest = 0;
  last = performance.now();
  await work();
  await new Promise((resolve) => setTimeout(resolve, 5));
  clearInterval(timer);
  return longest;
}

/** Half random, half repetitive: 16 MiB that takes zlib real work. */
function largeBlob(): Buffer {
  const bytes = Buffer.alloc(16 * 1024 * 1024);
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    randomBytes(4096).copy(bytes, offset);
    bytes.fill(offset % 251, offset + 4096, Math.min(offset + 8192, bytes.length));
  }
  return bytes;
}

/**
 * Stalls are compared with the synchronous call they replace, on the same host
 * at the same moment. Any one quiet attempt passes: the synchronous path can
 * never produce a quiet attempt, however idle the host is.
 */
async function expectLoopStaysFree(makeWork: () => () => Promise<unknown>, syncCost: number) {
  const stalls: number[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const work = makeWork();
    stalls.push(await longestStall(work));
    if (stalls.at(-1)! < syncCost / 2) return;
  }
  throw new Error(
    `longest stalls ${stalls.map(Math.round).join(", ")} ms against ${Math.round(syncCost)} ms sync`,
  );
}

describe("the event loop during a 16 MiB write", () => {
  const blob = largeBlob();

  test("a put does not hold it for the compression", async () => {
    const syncCost = await longestStall(() => deflateSync(blob));
    await expectLoopStaysFree(() => {
      const store = new ObjectStore({ root: temp("ork-write-store-"), durable: true });
      return () => store.put("blob", blob);
    }, syncCost);
  });

  test("a capture of a 16 MiB file does not hold it for the compression", async () => {
    const repo = repoWith({ "large.bin": blob, "small.txt": "small\n" });
    const syncCost = await longestStall(() => deflateSync(blob));
    await expectLoopStaysFree(() => {
      const store = new ObjectStore({ root: temp("ork-write-store-"), durable: true });
      return async () => {
        const result = captured(
          await captureWorktree({ executor: new HostCaptureExecutor(repo), store }),
        );
        expect(result.coverage.retainedBytes).toBeGreaterThanOrEqual(blob.length);
      };
    }, syncCost);
  });
});
