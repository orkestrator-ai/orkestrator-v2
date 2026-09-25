import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DESIGN_LIMITS,
  type DesignOperationDescriptor,
} from "@orkestrator/protocol/design-operations";
import { isDesignError } from "./design-errors.js";
import { exportSave } from "./design-exports.js";
import { enforceRecycleBin, purge } from "./design-service-lifecycle.js";
import {
  createDesignHarness,
  deferred,
  trackUnhandledRejections,
  type DesignHarness,
} from "./design-test-support.js";

const frameInput = { name: "Screen", x: 0, y: 0, width: 400, height: 300, html: "<h1>Screen</h1>" };

describe("design lifecycle: tombstones, restore, purge, duplicate and fencing", () => {
  let harness: DesignHarness;
  let clock: number;
  const rejections = trackUnhandledRejections();
  const service = () => harness.service;
  const serviceOptions = () => ({ now: () => new Date(clock) });

  beforeEach(async () => {
    rejections.install();
    clock = Date.parse("2026-09-24T10:00:00.000Z");
    harness = await createDesignHarness({
      prefix: "ork-design-lifecycle-",
      service: serviceOptions(),
    });
  });
  afterEach(async () => {
    await harness.close();
    rejections.remove();
    expect(rejections.seen).toEqual([]);
    rejections.seen.length = 0;
  });

  const setup = async (environmentId = "env-1", name = "Lifecycle") => {
    const canvas = await service().create(environmentId, name, undefined, "user");
    const { frame } = await service().createFrame(canvas.id, environmentId, 1, frameInput, "user");
    return { canvasId: canvas.id, frameId: frame.id };
  };
  const run = (environmentId: string, descriptor: DesignOperationDescriptor) =>
    service().runOnce(environmentId, "user", descriptor);
  const failureOf = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: unknown) => error,
    );
  const exists = (file: string) =>
    stat(file).then(
      () => true,
      () => false,
    );

  test("delete creates a tombstone every reader sees, even when the hint is dropped", async () => {
    const { canvasId } = await setup();
    const clientGeneration = service().generation;
    await service().delete(canvasId, "env-1", "user");
    const hint = harness.events.at(-1)!;
    expect(hint).toMatchObject({ canvasId, kind: "deleted", revision: 2 });
    expect(Object.keys(hint).sort()).toEqual([
      "canvasId",
      "generation",
      "kind",
      "revision",
      "statusVersion",
    ]);
    // A client that never received the hint still learns about the deletion.
    const tombstone = {
      kind: "deleted",
      canvasId,
      revision: 2,
      restorable: true,
      name: "Lifecycle",
    };
    expect(await service().snapshot("env-1", canvasId)).toMatchObject(tombstone);
    expect(await service().sync("env-1", canvasId, clientGeneration, 1, 0)).toMatchObject(
      tombstone,
    );
    expect(await service().sync("env-1", canvasId, "stale-generation", 99, 0)).toMatchObject(
      tombstone,
    );
    await expect(service().get(canvasId, "env-1")).rejects.toThrow("deleted");
    expect(await service().list("env-1")).toEqual([]);
    expect((await service().libraryPage("env-1", { filter: "deleted" })).entries).toMatchObject([
      { id: canvasId, state: "deleted" },
    ]);
    // Another environment learns nothing about it.
    expect(await service().snapshot("env-2", canvasId)).toMatchObject({ kind: "missing" });
    const restarted = await harness.restart(serviceOptions());
    expect(await restarted.snapshot("env-1", canvasId)).toMatchObject(tombstone);
    // Edits against a tombstone are refused.
    const error = await failureOf(
      restarted.mutate(canvasId, "env-1", crypto.randomUUID(), 1, { x: 1 }),
    );
    expect(isDesignError(error, "deleted")).toBe(true);
  });

  test("restore makes a new live revision and fences work prepared before deletion", async () => {
    const { canvasId, frameId } = await setup();
    const early = await service().prepare("env-1", "user", {
      canvasId,
      input: { kind: "update_frame", frameId, patch: { x: 10 } },
      preconditions: { frameRevision: 1 },
    });
    await service().delete(canvasId, "env-1", "user");
    await expect(
      run("env-1", {
        canvasId,
        input: { kind: "restore_canvas" },
        preconditions: { tombstoneRevision: 1 },
      }),
    ).rejects.toThrow("changed");
    await expect(
      run("env-2", {
        canvasId,
        input: { kind: "restore_canvas" },
        preconditions: { tombstoneRevision: 2 },
      }),
    ).rejects.toThrow("not found");
    const restored = await run("env-1", {
      canvasId,
      input: { kind: "restore_canvas" },
      preconditions: { tombstoneRevision: 2 },
    });
    expect(restored).toMatchObject({ state: "committed", result: { canvasRevision: 3 } });
    expect(harness.events.at(-1)).toMatchObject({ canvasId, kind: "restored", revision: 3 });
    const snapshot = await service().snapshot("env-1", canvasId);
    expect(snapshot).toMatchObject({
      kind: "snapshot",
      canvas: { revision: 3, frames: [{ id: frameId, x: 0 }] },
    });
    // No delta bridges a tombstone: a pre-deletion cursor resets to a snapshot.
    expect(await service().sync("env-1", canvasId, service().generation, 2, 0)).toMatchObject({
      kind: "reset",
    });
    // The edit prepared against the pre-deletion incarnation can never run.
    expect(await service().execute("env-1", canvasId, early.token)).toMatchObject({
      state: "expired",
    });
    expect((await service().getFrame(canvasId, "env-1", frameId)).x).toBe(0);
    await expect(
      run("env-1", { canvasId, input: { kind: "restore_canvas" }, preconditions: {} }),
    ).rejects.toThrow("not deleted");
  });

  test("purge removes a tombstone for good; old tokens never recreate the id", async () => {
    const { canvasId, frameId } = await setup();
    const move = await service().prepare("env-1", "user", {
      canvasId,
      input: { kind: "update_frame", frameId, patch: { x: 10 } },
      preconditions: { frameRevision: 1 },
    });
    await service().delete(canvasId, "env-1", "user");
    const restore = await service().prepare("env-1", "user", {
      canvasId,
      input: { kind: "restore_canvas" },
      preconditions: { tombstoneRevision: 2 },
    });
    await expect(purge(service(), "env-2", canvasId)).rejects.toThrow("not found");
    await purge(service(), "env-1", canvasId);
    expect(harness.events.at(-1)).toMatchObject({ canvasId, kind: "deleted" });
    for (const token of [move.token, restore.token])
      await expect(service().execute("env-1", canvasId, token)).rejects.toThrow("not found");
    expect(await service().snapshot("env-1", canvasId)).toMatchObject({ kind: "missing" });
    expect(await exists(service().store.recordFile(canvasId))).toBe(false);
    expect(await exists(service().store.pendingFile(canvasId))).toBe(false);
    expect(await exists(service().store.historyDir(canvasId))).toBe(false);
    const restarted = await harness.restart(serviceOptions());
    await expect(restarted.execute("env-1", canvasId, restore.token)).rejects.toThrow("not found");
    expect(await restarted.snapshot("env-1", canvasId)).toMatchObject({ kind: "missing" });
    expect((await restarted.libraryPage("env-1", { filter: "all" })).entries).toEqual([]);
    // Purging a live design is refused.
    const live = await setup();
    await expect(purge(restarted, "env-1", live.canvasId)).rejects.toThrow("Only deleted designs");
  });

  test("duplicating a canvas is idempotent and never copies sessions or export links", async () => {
    const { canvasId, frameId } = await setup();
    const worktree = await mkdtemp(join(tmpdir(), "ork-design-lifecycle-repo-"));
    try {
      await service().linkSession("env-1", canvasId, {
        tabId: "tab-1",
        platform: "claude",
        role: "design",
      });
      await exportSave(
        service(),
        "env-1",
        canvasId,
        { destination: { kind: "local", worktreePath: worktree } },
        {
          relativePath: "source.orkdes",
          revision: 2,
          expected: { state: "absent" },
        },
      );
      const source = await service().snapshot("env-1", canvasId);
      expect(source).toMatchObject({
        workspace: { sessions: [{ tabId: "tab-1" }], export: { relativePath: "source.orkdes" } },
      });
      await expect(
        run("env-1", {
          canvasId,
          input: { kind: "duplicate_canvas" },
          preconditions: { canvasRevision: 1 },
        }),
      ).rejects.toThrow("Design revision conflict:");
      await expect(
        run("env-2", {
          canvasId,
          input: { kind: "duplicate_canvas" },
          preconditions: { canvasRevision: 2 },
        }),
      ).rejects.toThrow("not found");
      const prepared = await service().prepare("env-1", "user", {
        canvasId,
        input: { kind: "duplicate_canvas", name: "Copy" },
        preconditions: { canvasRevision: 2 },
      });
      const [first, second] = await Promise.all([
        service().execute("env-1", canvasId, prepared.token),
        service().execute("env-1", canvasId, prepared.token),
      ]);
      expect(first).toEqual(second);
      const third = await service().execute("env-1", canvasId, prepared.token);
      expect(third).toEqual(first);
      const copyId = first.result!.createdCanvasId!;
      expect(copyId).not.toBe(canvasId);
      expect((await service().list("env-1")).map((entry) => entry.id).sort()).toEqual(
        [canvasId, copyId].sort(),
      );
      const copy = await service().snapshot("env-1", copyId);
      if (copy.kind !== "snapshot") throw new Error(`expected a snapshot, got ${copy.kind}`);
      expect(copy.canvas.name).toBe("Copy");
      expect(copy.canvas.frames).toHaveLength(1);
      expect(copy.canvas.frames[0]!.id).not.toBe(frameId);
      expect(copy.canvas.frames[0]!.html).toBe(frameInput.html);
      expect(copy.workspace.sessions).toEqual([]);
      expect(copy.workspace.export).toBeUndefined();
      expect(copy.workspace.history.undoCount).toBe(0);
      // The source is untouched by duplication.
      expect((await service().get(canvasId, "env-1")).revision).toBe(2);
      await harness.restart(serviceOptions());
      expect(await service().execute("env-1", canvasId, prepared.token)).toEqual(first);
      expect(await service().list("env-1")).toHaveLength(2);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test("rename, duplicate and delete frame obey CAS and environment ownership", async () => {
    const { canvasId, frameId } = await setup();
    await setup("env-2", "Elsewhere");
    await expect(
      run("env-1", {
        canvasId,
        input: { kind: "rename_canvas", name: "Stale" },
        preconditions: { canvasRevision: 1 },
      }),
    ).rejects.toThrow("Design revision conflict:");
    await expect(
      run("env-2", {
        canvasId,
        input: { kind: "rename_canvas", name: "Foreign" },
        preconditions: { canvasRevision: 2 },
      }),
    ).rejects.toThrow("not found");
    expect(
      await run("env-1", {
        canvasId,
        input: { kind: "rename_canvas", name: "Renamed" },
        preconditions: { canvasRevision: 2 },
      }),
    ).toMatchObject({ state: "committed", result: { canvasRevision: 3 } });
    await expect(
      run("env-1", {
        canvasId,
        input: { kind: "update_frame", frameId, patch: { name: "Stale" } },
        preconditions: { frameRevision: 0 },
      }),
    ).rejects.toThrow("Design revision conflict:");
    await expect(
      run("env-1", {
        canvasId,
        input: { kind: "update_frame", frameId, patch: { name: "Named" } },
        preconditions: { frameRevision: 1 },
      }),
    ).resolves.toMatchObject({ state: "committed" });
    const duplicateInput = { kind: "duplicate_frame" as const, frameId, name: "Twin" };
    await expect(
      run("env-1", { canvasId, input: duplicateInput, preconditions: { frameRevision: 1 } }),
    ).rejects.toThrow("Design revision conflict:");
    await expect(
      run("env-2", { canvasId, input: duplicateInput, preconditions: { frameRevision: 2 } }),
    ).rejects.toThrow("not found");
    await expect(
      run("env-1", {
        canvasId,
        input: duplicateInput,
        preconditions: { frameRevision: 2, canvasRevision: 3 },
      }),
    ).rejects.toThrow("Design revision conflict:");
    const duplicated = await run("env-1", {
      canvasId,
      input: duplicateInput,
      preconditions: { frameRevision: 2, canvasRevision: 4 },
    });
    const twinId = duplicated.result!.createdFrameId!;
    expect(twinId).toBeDefined();
    expect(await service().getFrame(canvasId, "env-1", twinId)).toMatchObject({
      name: "Twin",
      html: frameInput.html,
    });
    await expect(
      run("env-1", {
        canvasId,
        input: { kind: "delete_frame", frameId },
        preconditions: { frameRevision: 1 },
      }),
    ).rejects.toThrow("Design revision conflict:");
    await expect(
      run("env-2", {
        canvasId,
        input: { kind: "delete_frame", frameId },
        preconditions: { frameRevision: 2 },
      }),
    ).rejects.toThrow("not found");
    await run("env-1", {
      canvasId,
      input: { kind: "delete_frame", frameId },
      preconditions: { frameRevision: 2 },
    });
    expect((await service().get(canvasId, "env-1")).frames.map((frame) => frame.id)).toEqual([
      twinId,
    ]);
    // Frame deletion is recoverable through history.
    await service().undo(canvasId, "env-1", (await service().get(canvasId, "env-1")).revision);
    expect((await service().get(canvasId, "env-1")).frames.map((frame) => frame.id)).toEqual([
      frameId,
      twinId,
    ]);
  });

  test("a render finishing after canvas deletion does not resurrect it", async () => {
    const { canvasId, frameId } = await setup();
    const gate = deferred();
    harness.renderer.block = (job) =>
      job.operation.op === "applyStyles" ? gate.promise : undefined;
    const edit = service().mutate(
      canvasId,
      "env-1",
      frameId,
      1,
      { op: "setStyles", selector: "h1", styles: { color: "red" } },
      "agent",
    );
    const outcome = failureOf(edit);
    await harness.renderer.started((job) => job.op === "applyStyles");
    await service().delete(canvasId, "env-1", "user");
    gate.resolve();
    expect(isDesignError(await outcome, "deleted")).toBe(true);
    expect(await service().snapshot("env-1", canvasId)).toMatchObject({
      kind: "deleted",
      revision: 2,
    });
    const restarted = await harness.restart(serviceOptions());
    expect(await restarted.snapshot("env-1", canvasId)).toMatchObject({
      kind: "deleted",
      revision: 2,
    });
  });

  test("a render finishing after delete and restore never lands in the restored design", async () => {
    const { canvasId, frameId } = await setup();
    const gate = deferred();
    harness.renderer.block = (job) =>
      job.operation.op === "applyStyles" ? gate.promise : undefined;
    const outcome = failureOf(
      service().mutate(
        canvasId,
        "env-1",
        frameId,
        1,
        { op: "setStyles", selector: "h1", styles: { color: "red" } },
        "agent",
      ),
    );
    await harness.renderer.started((job) => job.op === "applyStyles");
    await service().delete(canvasId, "env-1", "user");
    await run("env-1", {
      canvasId,
      input: { kind: "restore_canvas" },
      preconditions: { tombstoneRevision: 2 },
    });
    gate.resolve();
    expect(isDesignError(await outcome, "conflict")).toBe(true);
    const frame = await service().getFrame(canvasId, "env-1", frameId);
    expect(frame.html).not.toContain("color");
  });

  test("a frame recreated from history never reuses a revision that named other content", async () => {
    const { canvasId, frameId } = await setup();
    await service().mutate(canvasId, "env-1", frameId, 1, { html: "<h1>Two</h1>" }, "user");
    const canvas = await service().get(canvasId, "env-1");
    const replace = (await service().historyPage("env-1", canvasId)).entries.find(
      (entry) => entry.kind === "replace_frame_html",
    )!;
    await run("env-1", {
      canvasId,
      input: { kind: "delete_frame", frameId },
      preconditions: { frameRevision: 2, canvasRevision: canvas.revision },
    });
    // Restore the state *before* the replacement: content "Screen", not "Two".
    const latest = await service().get(canvasId, "env-1");
    await run("env-1", {
      canvasId,
      input: { kind: "restore_checkpoint", entryId: replace.id, side: "before" },
      preconditions: { canvasRevision: latest.revision },
    });
    const restored = await service().getFrame(canvasId, "env-1", frameId);
    expect(restored.html).toBe(frameInput.html);
    expect(restored.revision).toBeGreaterThan(2);
    // An agent that still believes revision 2 means "Two" is refused.
    const stale = await failureOf(
      service().mutate(canvasId, "env-1", frameId, 2, { html: "<h1>Agent</h1>" }, "agent"),
    );
    expect(isDesignError(stale, "conflict")).toBe(true);
  });

  test("work finishing after environment deletion leaves no files behind", async () => {
    const { canvasId, frameId } = await setup();
    const kept = await setup("env-keep", "Kept");
    const gate = deferred();
    harness.renderer.block = (job) =>
      job.operation.op === "applyStyles" ? gate.promise : undefined;
    const outcome = failureOf(
      service().mutate(
        canvasId,
        "env-1",
        frameId,
        1,
        { op: "setStyles", selector: "h1", styles: { color: "red" } },
        "agent",
      ),
    );
    await harness.renderer.started((job) => job.op === "applyStyles");
    expect(await service().deleteEnvironment("env-1")).toBe(1);
    gate.resolve();
    expect(isDesignError(await outcome, "not-found")).toBe(true);
    expect(await service().snapshot("env-1", canvasId)).toMatchObject({ kind: "missing" });
    await expect(service().create("env-1", "Late")).rejects.toThrow();
    await service().close();
    const root = join(harness.dir, "design-canvases");
    const leftovers = (await readdir(root, { recursive: true })).filter((file) =>
      file.includes(canvasId),
    );
    expect(leftovers).toEqual([]);
    const restarted = await harness.restart(serviceOptions());
    expect(await restarted.snapshot("env-1", canvasId)).toMatchObject({ kind: "missing" });
    expect(restarted.hasCanvases("env-1")).toBe(false);
    expect((await restarted.get(kept.canvasId, "env-keep")).frames).toHaveLength(1);
  });

  test("the recycle bin is bounded by count and retention age", async () => {
    const deleted: string[] = [];
    for (let index = 0; index <= DESIGN_LIMITS.recycleCanvases; index++) {
      const canvas = await service().create("env-1", `Trash ${index}`, undefined, "user");
      clock += 1000;
      await service().delete(canvas.id, "env-1", "user");
      deleted.push(canvas.id);
    }
    await enforceRecycleBin(service());
    const page = await service().libraryPage("env-1", { filter: "deleted" });
    expect(page.total).toBe(DESIGN_LIMITS.recycleCanvases);
    expect(page.quota).toMatchObject({ deleted: DESIGN_LIMITS.recycleCanvases, live: 0 });
    // The oldest tombstone was purged; the newest remain restorable.
    expect(await service().snapshot("env-1", deleted[0]!)).toMatchObject({ kind: "missing" });
    expect(await service().snapshot("env-1", deleted.at(-1)!)).toMatchObject({
      kind: "deleted",
      restorable: true,
    });
    const survivor = await setup();
    // After the retention window every tombstone is purged at startup; live designs stay.
    clock += DESIGN_LIMITS.recycleRetentionMs + 60_000;
    const restarted = await harness.restart(serviceOptions());
    await restarted.initialize();
    expect((await restarted.libraryPage("env-1", { filter: "deleted" })).total).toBe(0);
    expect(await restarted.list("env-1")).toEqual([
      { id: survivor.canvasId, name: "Lifecycle", revision: 2 },
    ]);
  });

  test("recycle enforcement skips a canvas restored after its selection", async () => {
    const { canvasId } = await setup();
    await service().delete(canvasId, "env-1", "user");
    clock += DESIGN_LIMITS.recycleRetentionMs + 1;
    const selected = deferred();
    const release = deferred();
    const originalLane = service().lane.bind(service());
    let pauseOnce = true;
    service().lane = <T>(id: string, work: () => Promise<T>): Promise<T> => {
      if (id === canvasId && pauseOnce) {
        pauseOnce = false;
        selected.resolve();
        return release.promise.then(() => originalLane(id, work));
      }
      return originalLane(id, work);
    };
    const enforcement = enforceRecycleBin(service());
    await selected.promise;
    const restored = await run("env-1", {
      canvasId,
      input: { kind: "restore_canvas" },
      preconditions: { tombstoneRevision: 2 },
    });
    expect(restored.state).toBe("committed");
    release.resolve();
    await enforcement;
    service().lane = originalLane;
    expect((await service().get(canvasId, "env-1")).frames).toHaveLength(1);
    expect(await exists(service().store.historyDir(canvasId))).toBe(true);
  });
});
