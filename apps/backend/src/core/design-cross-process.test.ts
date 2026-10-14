import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readdir, readFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import type { DesignOperationDescriptor } from "@orkestrator/protocol/design-operations";
import { DESIGN_LIBRARY_SIGNAL_STORE } from "./design-coordination.js";
import { isDesignError } from "./design-errors.js";
import { purge } from "./design-service-lifecycle.js";
import type { DesignPendingOperation, DesignPrivateRecord } from "./design-records.js";
import { DesignService } from "./design-service.js";
import {
  createDesignHarness,
  createTestRenderer,
  trackUnhandledRejections,
  type DesignHarness,
  type TestRenderer,
} from "./design-test-support.js";
import { StorageDatabase } from "./storage-database.js";
import { openBackendDatabase } from "./storage-stores.js";
import { storageFilesContain } from "./storage-test-support.js";

const frameInput = { name: "Home", x: 0, y: 0, width: 400, height: 300, html: "<h1>Hello</h1>" };

/**
 * Two design services on one data directory stand in for two backend
 * processes: they share only the files and the database (leases, change
 * signal), never memory.
 */
describe("design canvases across processes sharing one data directory", () => {
  let harness: DesignHarness;
  let other: DesignService | undefined;
  let otherRenderer: TestRenderer;
  const extra: DesignService[] = [];
  const rejections = trackUnhandledRejections();
  const a = () => harness.service;
  const b = () => {
    otherRenderer ??= createTestRenderer();
    other ??= new DesignService(harness.dir, () => {}, otherRenderer);
    return other;
  };
  const third = () => {
    const service = new DesignService(harness.dir, () => {}, createTestRenderer());
    extra.push(service);
    return service;
  };

  beforeEach(async () => {
    rejections.install();
    harness = await createDesignHarness({ prefix: "ork-design-xproc-" });
    other = undefined;
    otherRenderer = createTestRenderer();
  });
  afterEach(async () => {
    for (const service of extra.splice(0)) await service.close();
    await other?.close();
    await harness.close();
    rejections.remove();
    expect(rejections.seen).toEqual([]);
    rejections.seen.length = 0;
  });

  const setup = async (frames = 1, environmentId = "env-1") => {
    const canvas = await a().create(environmentId, "Shared", undefined, "user");
    const ids: string[] = [];
    for (let index = 0; index < frames; index++) {
      const { frame } = await a().createFrame(
        canvas.id,
        environmentId,
        index + 1,
        { ...frameInput, name: `F${index}`, x: index * 500 },
        "user",
      );
      ids.push(frame.id);
    }
    return { canvasId: canvas.id, frameIds: ids };
  };
  const move = (
    canvasId: string,
    frameId: string,
    frameRevision: number,
    x: number,
  ): DesignOperationDescriptor => ({
    canvasId,
    input: { kind: "update_frame", frameId, patch: { x } },
    preconditions: { frameRevision },
  });
  const recordOf = async (canvasId: string) =>
    JSON.parse(await readFile(a().store.recordFile(canvasId), "utf8")) as DesignPrivateRecord;

  test("a stale cached record never overwrites another process's commit", async () => {
    const { canvasId, frameIds } = await setup(2);
    const [first, second] = frameIds as [string, string];
    // B caches the record, then A commits a change B has not seen.
    expect((await b().get(canvasId, "env-1")).revision).toBe(3);
    await a().mutate(canvasId, "env-1", first, 1, { x: 111 }, "user");
    // B edits the other frame from its stale cache: A's change must survive.
    await b().mutate(canvasId, "env-1", second, 1, { x: 222 }, "user");
    const record = await recordOf(canvasId);
    expect(record.document.frames.map((frame) => frame.x)).toEqual([111, 222]);
    expect(record.document.revision).toBe(5);
    // Both processes now read the same committed state.
    expect(await a().get(canvasId, "env-1")).toEqual(await b().get(canvasId, "env-1"));
    // A precondition from A's stale view is a conflict, not a silent overwrite.
    await expect(a().mutate(canvasId, "env-1", second, 1, { x: 333 }, "user")).rejects.toThrow(
      "Design revision conflict",
    );
    expect((await recordOf(canvasId)).document.frames[1]!.x).toBe(222);
  });

  test("concurrent edit chains in two processes all commit, revisions stay monotonic", async () => {
    const { canvasId, frameIds } = await setup(2);
    const chain = async (service: DesignService, frameId: string) => {
      for (let step = 1; step <= 5; step++)
        await service.mutate(canvasId, "env-1", frameId, step, { x: step * 10 }, "user");
    };
    await Promise.all([chain(a(), frameIds[0]!), chain(b(), frameIds[1]!)]);
    const record = await recordOf(canvasId);
    expect(record.document.frames.map((frame) => [frame.x, frame.revision])).toEqual([
      [50, 6],
      [50, 6],
    ]);
    expect(record.document.revision).toBe(13);
    const revisions = record.receipts
      .filter((receipt) => receipt.state === "committed")
      .map((receipt) => receipt.result!.canvasRevision);
    expect(revisions).toEqual([...revisions].sort((x, y) => x - y));
    expect(new Set(revisions).size).toBe(revisions.length);
  });

  test("a lane waits for another process's canvas lease before committing", async () => {
    const { canvasId, frameIds } = await setup();
    const foreign = openBackendDatabase(harness.dir);
    try {
      const release = await foreign.acquireLease(`design-canvases/${canvasId}`, "test holder");
      let settled = false;
      const edit = a()
        .mutate(canvasId, "env-1", frameIds[0]!, 1, { x: 9 }, "user")
        .finally(() => {
          settled = true;
        });
      await Bun.sleep(200);
      expect(settled).toBe(false);
      expect((await recordOf(canvasId)).document.frames[0]!.x).toBe(0);
      await release();
      await edit;
      expect((await recordOf(canvasId)).document.frames[0]!.x).toBe(9);
    } finally {
      foreign.close();
    }
  });

  test("startup recovery leaves a live process's pending work alone", async () => {
    const { canvasId, frameIds } = await setup();
    const prepared = await a().prepare("env-1", "user", move(canvasId, frameIds[0]!, 1, 42));
    const pending = JSON.parse(
      await readFile(a().store.pendingFile(canvasId), "utf8"),
    ) as DesignPendingOperation[];
    expect(pending[0]!.owner).toBe(a().generation);
    // B starts while A is alive: its recovery must not interrupt A's token.
    await b().initialize();
    expect(await b().status("env-1", canvasId, prepared.token)).toMatchObject({
      state: "prepared",
    });
    expect((await recordOf(canvasId)).receipts.map((receipt) => receipt.token)).not.toContain(
      prepared.token,
    );
    expect(await a().execute("env-1", canvasId, prepared.token)).toMatchObject({
      state: "committed",
    });
    expect((await b().get(canvasId, "env-1")).frames[0]!.x).toBe(42);
  });

  test("a create reserved by a live process survives another process's startup", async () => {
    const prepared = await a().prepare("env-1", "user", {
      input: { kind: "create_canvas", name: "Reserved" },
      preconditions: {},
      correlationId: "reserve-1",
    });
    await b().initialize();
    expect(
      await b().prepare("env-1", "user", {
        input: { kind: "create_canvas", name: "Reserved" },
        preconditions: {},
        correlationId: "reserve-1",
      }),
    ).toMatchObject({ token: prepared.token, canvasId: prepared.canvasId });
    const status = await a().execute("env-1", prepared.canvasId, prepared.token);
    expect(status).toMatchObject({ state: "committed" });
    expect((await b().get(prepared.canvasId, "env-1")).name).toBe("Reserved");
  });

  test("work owned by a process that stopped is interrupted, also for a running peer", async () => {
    const { canvasId, frameIds } = await setup();
    // B (a peer that is already running) and the doomed process D.
    await b().initialize();
    const doomed = third();
    const prepared = await doomed.prepare("env-1", "user", move(canvasId, frameIds[0]!, 1, 7));
    expect(await b().status("env-1", canvasId, prepared.token)).toMatchObject({
      state: "prepared",
    });
    await doomed.close();
    // B never restarted, yet it never runs the dead process's admitted work.
    const jobs = otherRenderer.jobs.length;
    const status = await b().status("env-1", canvasId, prepared.token);
    expect(status).toMatchObject({ state: "interrupted", failure: { code: "unknown-outcome" } });
    const executed = await b().execute("env-1", canvasId, prepared.token);
    expect(executed).toMatchObject({ state: "interrupted" });
    expect(await b().execute("env-1", canvasId, prepared.token)).toEqual(executed);
    expect(otherRenderer.jobs.length).toBe(jobs);
    expect((await recordOf(canvasId)).document.frames[0]!.x).toBe(0);
    // A process starting later finds the receipt and nothing left to recover.
    const later = third();
    expect(await later.status("env-1", canvasId, prepared.token)).toEqual(executed);
  });

  test("a peer may execute a live process's token once; the second runner gets the receipt", async () => {
    const { canvasId, frameIds } = await setup();
    const prepared = await a().prepare("env-1", "user", move(canvasId, frameIds[0]!, 1, 64));
    const [fromB, fromA] = await Promise.all([
      b().execute("env-1", canvasId, prepared.token),
      a().execute("env-1", canvasId, prepared.token),
    ]);
    expect(fromB.state).toBe("committed");
    expect(fromA).toEqual(fromB);
    const record = await recordOf(canvasId);
    expect(record.receipts.filter((receipt) => receipt.token === prepared.token)).toHaveLength(1);
    expect(record.document.frames[0]).toMatchObject({ x: 64, revision: 2 });
  });

  test("library, quota and recycle bin include canvases another process created", async () => {
    await a().initialize();
    const fromB = await b().create("env-1", "From B", undefined, "user");
    const doomed = await b().create("env-1", "Doomed", undefined, "user");
    expect((await a().list("env-1")).map((entry) => entry.name).sort()).toEqual([
      "Doomed",
      "From B",
    ]);
    const page = await a().libraryPage("env-1", {});
    expect(page.total).toBe(2);
    expect(page.quota.live).toBe(2);
    expect((await a().readiness()).storage.canvases).toBe(2);
    await b().delete(doomed.id, "env-1", "user");
    const bin = await a().libraryPage("env-1", { filter: "deleted" });
    expect(bin.entries.map((entry) => entry.id)).toEqual([doomed.id]);
    expect(bin.quota.deleted).toBe(1);
    // A purges B's deleted canvas; B sees it gone.
    await purge(a(), "env-1", doomed.id);
    expect(await b().snapshot("env-1", doomed.id)).toMatchObject({ kind: "missing" });
    expect((await b().libraryPage("env-1", { filter: "all" })).entries.map((e) => e.id)).toEqual([
      fromB.id,
    ]);
    // The synchronous check catches up after its background refresh.
    await a().refreshLibrary();
    expect(a().hasCanvases("env-1")).toBe(true);
  });

  test("environment deletion removes canvases another process created", async () => {
    const own = await a().create("env-gone", "Mine", undefined, "user");
    const foreign = await b().create("env-gone", "Theirs", undefined, "user");
    const kept = await b().create("env-keep", "Kept", undefined, "user");
    expect(await a().deleteEnvironment("env-gone")).toBe(2);
    for (const id of [own.id, foreign.id]) {
      expect(await b().snapshot("env-gone", id)).toMatchObject({ kind: "missing" });
      await expect(readFile(a().store.recordFile(id))).rejects.toThrow();
    }
    expect((await b().list("env-gone")).length).toBe(0);
    expect((await a().get(kept.id, "env-keep")).name).toBe("Kept");
  });

  test("checkpoint collection keeps checkpoints another process's record references", async () => {
    const { canvasId, frameIds } = await setup();
    const frameId = frameIds[0]!;
    // B caches the record before A creates more history.
    const before = await b().historyStatus(canvasId, "env-1");
    for (let step = 1; step <= 3; step++)
      await a().mutate(canvasId, "env-1", frameId, step, { x: step }, "user");
    const record = await recordOf(canvasId);
    const referenced = record.history.entries.map((entry) => entry.checkpoint);
    expect(referenced.length).toBeGreaterThan(before.undoCount);
    // Age every checkpoint past the collection gate.
    const dir = a().store.historyDir(canvasId);
    const old = new Date(Date.now() - 60 * 60_000);
    for (const file of await readdir(dir)) await utimes(join(dir, file), old, old);
    expect(await b().collectHistoryOrphans(canvasId)).toBe(0);
    expect((await readdir(dir)).sort()).toEqual([...referenced].sort());
    // A's history still works.
    await a().undo(canvasId, "env-1", record.document.revision);
    expect((await a().getFrame(canvasId, "env-1", frameId)).x).toBe(2);
  });

  test("a lease that cannot be taken fails retryably and changes nothing", async () => {
    const { canvasId, frameIds } = await setup();
    const before = await recordOf(canvasId);
    const acquire = spyOn(StorageDatabase.prototype, "acquireLease");
    acquire.mockImplementationOnce(() =>
      Promise.reject(new Error("Timed out waiting for design canvas lock")),
    );
    try {
      const failure = await a()
        .mutate(canvasId, "env-1", frameIds[0]!, 1, { x: 5 }, "user")
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(isDesignError(failure, "capacity")).toBe(true);
    } finally {
      acquire.mockRestore();
    }
    expect(await recordOf(canvasId)).toEqual(before);
    // Nothing was admitted, so the same edit runs normally afterwards.
    await a().mutate(canvasId, "env-1", frameIds[0]!, 1, { x: 5 }, "user");
    expect((await recordOf(canvasId)).document.frames[0]!.x).toBe(5);
  });

  test("a failed change signal never fails the commit; the next signal catches the peer up", async () => {
    await a().initialize();
    await b().initialize();
    const write = spyOn(StorageDatabase.prototype, "writeStoreInTransaction");
    write.mockImplementation(() => {
      throw new Error("injected signal failure");
    });
    let missed: { id: string };
    try {
      missed = await b().create("env-1", "Unsignalled", undefined, "user");
    } finally {
      write.mockRestore();
    }
    expect((await b().get(missed.id, "env-1")).name).toBe("Unsignalled");
    const seen = await b().create("env-1", "Signalled", undefined, "user");
    expect((await a().list("env-1")).map((entry) => entry.id).sort()).toEqual(
      [missed.id, seen.id].sort(),
    );
  });

  test("coordination keeps no design content in the database; purge leaves none", async () => {
    const secret = "cross-process-secret-7f3a";
    const canvas = await a().create("env-1", "Private", undefined, "user");
    await a().createFrame(canvas.id, "env-1", 1, { ...frameInput, html: `<p>${secret}</p>` });
    await b().list("env-1");
    expect(storageFilesContain(harness.dir, secret)).toBe(false);
    expect(storageFilesContain(harness.dir, DESIGN_LIBRARY_SIGNAL_STORE)).toBe(true);
    await a().delete(canvas.id, "env-1", "user");
    await purge(b(), "env-1", canvas.id);
    expect(storageFilesContain(harness.dir, secret)).toBe(false);
    expect(await a().snapshot("env-1", canvas.id)).toMatchObject({ kind: "missing" });
  });
});
