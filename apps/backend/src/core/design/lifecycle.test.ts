import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DESIGN_LIMITS,
  type DesignOperationDescriptor,
} from "@orkestrator/protocol/design-operations";
import { isDesignError } from "./errors.js";
import { exportSave } from "./exports.js";
import { enforceRecycleBin, purge } from "./service-lifecycle.js";
import { DesignService } from "./service.js";
import {
  createDesignHarness,
  createTestRenderer,
  deferred,
  trackUnhandledRejections,
  type DesignHarness,
} from "./test-support.js";

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

  describe("a duplicate stopped between its copy and its source receipt", () => {
    // Fails this many writes of the source record; the copy's commit passes.
    let failSource: { canvasId: string; times: number } | undefined;
    const faulty = () => ({
      ...serviceOptions(),
      faults: {
        beforeRename: (file: string) => {
          if (!failSource?.times || !file.endsWith(`${failSource.canvasId}.orkrec`)) return;
          failSource.times--;
          throw new Error("injected source crash");
        },
      },
    });
    const prepareDuplicate = async () => {
      await harness.restart(faulty());
      const { canvasId } = await setup();
      const prepared = await service().prepare("env-1", "user", {
        canvasId,
        input: { kind: "duplicate_canvas", name: "Copy" },
        preconditions: { canvasRevision: 2 },
        correlationId: "duplicate-once",
      });
      return { canvasId, token: prepared.token };
    };
    const copies = async (canvasId: string) =>
      (await service().list("env-1")).map((entry) => entry.id).filter((id) => id !== canvasId);

    test("records it committed when the source write fails once", async () => {
      const { canvasId, token } = await prepareDuplicate();
      failSource = { canvasId, times: 1 };
      const status = await service().execute("env-1", canvasId, token);
      const [copyId] = await copies(canvasId);
      expect(copyId).toBeDefined();
      expect(status).toMatchObject({
        state: "committed",
        result: { createdCanvasId: copyId, canvasRevision: 2 },
      });
      expect(await service().status("env-1", canvasId, token)).toEqual(status);
      expect(await copies(canvasId)).toEqual([copyId!]);
    });

    test("reconciles a committed copy on its live owner while source writes keep failing", async () => {
      const { canvasId, token } = await prepareDuplicate();
      failSource = { canvasId, times: Number.POSITIVE_INFINITY };
      const status = await service().execute("env-1", canvasId, token);
      const [copyId] = await copies(canvasId);
      expect(copyId).toBeDefined();
      expect(status).toMatchObject({
        state: "committed",
        result: { createdCanvasId: copyId, canvasRevision: 2 },
      });
      expect(await service().status("env-1", canvasId, token)).toEqual(status);
      expect(await service().execute("env-1", canvasId, token)).toEqual(status);
      expect((await service().store.readPending(canvasId)).map((entry) => entry.token)).toEqual([
        token,
      ]);
      const descriptor: DesignOperationDescriptor = {
        canvasId,
        input: { kind: "duplicate_canvas", name: "Copy" },
        preconditions: { canvasRevision: 2 },
        correlationId: "duplicate-once",
      };
      expect(await service().prepare("env-1", "user", descriptor)).toMatchObject({ token });
      await expect(
        service().prepare("env-1", "user", {
          ...descriptor,
          correlationId: "another-duplicate",
        }),
      ).rejects.toThrow("earlier duplicate already committed");
      expect(await copies(canvasId)).toEqual([copyId!]);
      // Once saving works, replay persists the receipt and removes pending.
      failSource = undefined;
      expect(await service().execute("env-1", canvasId, token)).toEqual(status);
      expect(await service().store.readPending(canvasId)).toEqual([]);
      expect(await service().status("env-1", canvasId, token)).toEqual(status);
    });

    test("records it committed with the copy after the backend restarts", async () => {
      const { canvasId, token } = await prepareDuplicate();
      failSource = { canvasId, times: Number.POSITIVE_INFINITY };
      try {
        expect(await service().execute("env-1", canvasId, token)).toMatchObject({
          state: "committed",
        });
      } finally {
        failSource = undefined;
      }
      const [copyId] = await copies(canvasId);
      expect(copyId).toBeDefined();
      await harness.restart(serviceOptions());
      const status = await service().status("env-1", canvasId, token);
      expect(status).toMatchObject({
        state: "committed",
        result: { createdCanvasId: copyId, canvasRevision: 2 },
      });
      expect(await service().execute("env-1", canvasId, token)).toEqual(status);
      // The retry the client makes after a lost response reconciles to it.
      await expect(
        service().prepare("env-1", "user", {
          canvasId,
          input: { kind: "duplicate_canvas", name: "Copy" },
          preconditions: { canvasRevision: 2 },
          correlationId: "duplicate-once",
        }),
      ).rejects.toThrow("already has a settled operation");
      expect(await copies(canvasId)).toEqual([copyId!]);
    });

    test("status prefers a committed copy over an unrecorded live-owner failure", async () => {
      const { canvasId, token } = await prepareDuplicate();
      const store = service().store;
      const readPending = store.readPending.bind(store);
      let reads = 0;
      failSource = { canvasId, times: Number.POSITIVE_INFINITY };
      // Fail recovery's pending read after the copy and the first source write,
      // forcing the operation's outer catch to remember an unknown outcome.
      store.readPending = async (id) => {
        if (id === canvasId && ++reads === 2) throw new Error("pending read unavailable");
        return readPending(id);
      };
      try {
        expect(String(await failureOf(service().execute("env-1", canvasId, token)))).toContain(
          "pending read unavailable",
        );
      } finally {
        store.readPending = readPending;
      }
      const [copyId] = await copies(canvasId);
      expect(copyId).toBeDefined();
      expect(await service().status("env-1", canvasId, token)).toMatchObject({
        state: "committed",
        result: { createdCanvasId: copyId },
      });
      expect(await service().execute("env-1", canvasId, token)).toMatchObject({
        state: "committed",
        result: { createdCanvasId: copyId },
      });
      expect(await copies(canvasId)).toEqual([copyId!]);
    });

    test("reports it committed to a running peer before any restart recovery", async () => {
      const { canvasId, token } = await prepareDuplicate();
      // A peer sharing the data directory that was already running.
      const peer = new DesignService(harness.dir, () => {}, createTestRenderer(), serviceOptions());
      try {
        await peer.initialize();
        failSource = { canvasId, times: Number.POSITIVE_INFINITY };
        try {
          await failureOf(service().execute("env-1", canvasId, token));
        } finally {
          failSource = undefined;
        }
        const [copyId] = await copies(canvasId);
        // The owner stops; its replacement has not started (no recovery ran).
        await harness.restart(serviceOptions());
        expect((await peer.store.readPending(canvasId)).map((entry) => entry.token)).toEqual([
          token,
        ]);
        const status = await peer.status("env-1", canvasId, token);
        expect(status).toMatchObject({ state: "committed", result: { createdCanvasId: copyId } });
        expect(await peer.execute("env-1", canvasId, token)).toMatchObject(status);
        expect(await peer.status("env-1", canvasId, token)).toMatchObject({
          state: "committed",
          result: { createdCanvasId: copyId },
        });
      } finally {
        await peer.close();
      }
    });
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

  // Bun's async recursive readdir lists subdirectories concurrently, so its
  // entry order varies between calls (a child can precede its parent). Sort
  // to compare the set of paths, not the traversal order.
  const canvasFiles = async (canvasId: string) =>
    (await readdir(join(harness.dir, "design-canvases"), { recursive: true }))
      .filter((file) => file.includes(canvasId))
      .toSorted();

  for (const problem of ["unparsable", "unreadable"] as const) {
    test(`the orphan sweep keeps a canvas with an ${problem} owner`, async () => {
      const { canvasId } = await setup("env-unknown");
      const file = service().store.recordFile(canvasId);
      if (problem === "unreadable") {
        await rm(file);
        await mkdir(file);
      } else {
        await writeFile(file, "{ torn record without an owner");
      }
      service().coordination.beginLibraryChange(canvasId);
      clock = Date.now() + 2 * 60 * 60_000;
      const before = await canvasFiles(canvasId);
      expect(await service().sweepOrphanedCanvases(async () => new Set(), 60 * 60_000)).toBe(0);
      expect(service().library.entries.get(canvasId)).toMatchObject({
        state: "problem",
        environmentId: "",
      });
      expect(await canvasFiles(canvasId)).toEqual(before);
    });
  }

  for (const change of ["owner", "fresh", "removed"] as const) {
    test(`the orphan sweep rechecks a peer's ${change} record after waiting for its lane`, async () => {
      const { canvasId } = await setup("env-gone");
      const kept = await setup("env-keep", "Kept");
      clock = Date.now();
      const old = new Date(clock - 2 * 60 * 60_000);
      await utimes(service().store.recordFile(canvasId), old, old);
      service().coordination.beginLibraryChange(canvasId);
      const peer = new DesignService(harness.dir, () => {}, harness.renderer, serviceOptions());
      const selected = deferred<void>();
      const release = deferred<void>();
      const originalLane = service().lane.bind(service());
      let pause = true;
      service().lane = (id, work) => {
        if (id === canvasId && pause) {
          pause = false;
          selected.resolve();
          return release.promise.then(() => originalLane(id, work));
        }
        return originalLane(id, work);
      };
      let sweep: Promise<number> | undefined;
      try {
        await peer.initialize();
        sweep = service().sweepOrphanedCanvases(async () => new Set(["env-keep"]), 60 * 60_000);
        await selected.promise;
        await peer.lane(canvasId, async () => {
          if (change === "removed") {
            await peer.store.remove(canvasId);
            peer.libraryRemoved(canvasId);
          } else {
            const loaded = await peer.store.read(canvasId);
            if (loaded.kind !== "record") throw new Error("expected record");
            if (change === "owner") loaded.record.environmentId = "env-keep";
            await peer.commit(loaded.record, false);
            // Keep the changed-owner case old, so ownership itself protects it.
            if (change === "owner") {
              await utimes(peer.store.recordFile(canvasId), old, old);
              peer.coordination.beginLibraryChange(canvasId);
            }
          }
        });
        release.resolve();
        expect(await sweep).toBe(0);
        if (change !== "removed")
          expect(await exists(service().store.recordFile(canvasId))).toBe(true);
        // A vanished record must not make the stale candidate remove sidecars.
        expect(await exists(service().store.historyDir(canvasId))).toBe(true);
        expect((await service().get(kept.canvasId, "env-keep")).frames).toHaveLength(1);
      } finally {
        release.resolve();
        await sweep;
        service().lane = originalLane;
        await peer.close();
      }
    });
  }

  for (const restart of [false, true]) {
    test(`interrupted sidecar cleanup keeps its root for ${restart ? "a restarted service" : "the next sweep"}`, async () => {
      const { canvasId } = await setup("env-gone");
      const kept = await setup("env-keep", "Kept");
      const store = service().store;
      await mkdir(store.exportBackupDir(canvasId), { recursive: true });
      await writeFile(join(store.exportBackupDir(canvasId), "backup"), "backup");
      await mkdir(join(store.root, "legacy-backups"), { recursive: true });
      await writeFile(store.legacyBackupFile(canvasId), "legacy backup");
      // A one-time unlink failure on pending data occurs inside store.remove.
      await mkdir(store.pendingFile(canvasId), { recursive: true });
      clock = Date.now() + 2 * 60 * 60_000;
      const live = new Set(["env-keep"]);
      expect(await service().sweepOrphanedCanvases(async () => live, 60 * 60_000)).toBe(0);
      expect(await exists(store.recordFile(canvasId))).toBe(true);
      expect(await exists(store.pendingFile(canvasId))).toBe(true);
      expect(await exists(store.historyDir(canvasId))).toBe(false);
      expect(await exists(store.exportBackupDir(canvasId))).toBe(false);
      expect(await exists(store.legacyBackupFile(canvasId))).toBe(false);
      await rm(store.pendingFile(canvasId), { recursive: true });
      await writeFile(store.pendingFile(canvasId), "[]");
      if (restart) {
        await harness.restart(serviceOptions());
        await service().initialize();
      }
      expect(await service().sweepOrphanedCanvases(async () => live, 60 * 60_000)).toBe(1);
      expect(await canvasFiles(canvasId)).toEqual([]);
      expect((await service().get(kept.canvasId, "env-keep")).frames).toHaveLength(1);
    });
  }

  test("a failure after root removal has no undiscoverable sidecars left", async () => {
    const { canvasId } = await setup("env-gone");
    const kept = await setup("env-keep", "Kept");
    const store = service().store;
    await mkdir(store.exportBackupDir(canvasId), { recursive: true });
    await writeFile(join(store.exportBackupDir(canvasId), "backup"), "backup");
    await mkdir(join(store.root, "legacy-backups"), { recursive: true });
    await writeFile(store.legacyBackupFile(canvasId), "legacy backup");
    await writeFile(store.pendingFile(canvasId), "[]");
    const remove = store.remove.bind(store);
    store.remove = async (id) => {
      await remove(id);
      throw new Error("interrupted after root unlink");
    };
    clock = Date.now() + 2 * 60 * 60_000;
    const live = new Set(["env-keep"]);
    expect(await service().sweepOrphanedCanvases(async () => live, 60 * 60_000)).toBe(0);
    expect(await canvasFiles(canvasId)).toEqual([]);
    expect(await service().sweepOrphanedCanvases(async () => live, 60 * 60_000)).toBe(0);
    await harness.restart(serviceOptions());
    await service().initialize();
    expect(await service().sweepOrphanedCanvases(async () => live, 60 * 60_000)).toBe(0);
    expect(await canvasFiles(canvasId)).toEqual([]);
    expect((await service().get(kept.canvasId, "env-keep")).frames).toHaveLength(1);
  });

  test("the orphan sweep finishes a deletion that stopped after fencing", async () => {
    const { canvasId } = await setup("env-1");
    const kept = await setup("env-keep", "Kept");
    // Deletion fences first; a crash before the files go leaves them behind
    // while the environment record still exists.
    service().coordination.fenceEnvironment("env-1");
    const live = new Set(["env-1", "env-keep"]);
    expect(await service().sweepOrphanedCanvases(async () => live, 60 * 60_000)).toBe(1);
    expect(await canvasFiles(canvasId)).toEqual([]);
    expect(service().hasCanvases("env-1")).toBe(false);
    expect((await service().get(kept.canvasId, "env-keep")).frames).toHaveLength(1);
    expect(await service().sweepOrphanedCanvases(async () => live, 60 * 60_000)).toBe(0);
  });

  test("the orphan sweep removes an absent environment's canvases once they are old enough", async () => {
    const { canvasId } = await setup("env-gone");
    const kept = await setup("env-keep", "Kept");
    const live = new Set(["env-keep"]);
    clock = Date.now();
    expect(await service().sweepOrphanedCanvases(async () => live, 60 * 60_000)).toBe(0);
    expect(await canvasFiles(canvasId)).not.toEqual([]);
    clock = Date.now() + 2 * 60 * 60_000;
    expect(await service().sweepOrphanedCanvases(async () => live, 60 * 60_000)).toBe(1);
    expect(await canvasFiles(canvasId)).toEqual([]);
    expect((await service().get(kept.canvasId, "env-keep")).frames).toHaveLength(1);
  });
});
