import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DESIGN_HISTORY_MAX_BYTES,
  DESIGN_MAX_FRAMES,
  DESIGN_MAX_HTML_BYTES,
  type DesignCanvas,
  type DesignCanvasState,
} from "@orkestrator/protocol/design-canvas";
import { DesignService } from "./design-service.js";
import { designActions, runDesignAction } from "./design-tools.js";

describe("backend design canvases", () => {
  let dir: string, service: DesignService;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ork-design-test-"));
    service = new DesignService(dir, () => {});
  });
  afterEach(async () => {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  });
  const frame = { name: "Home", x: 0, y: 0, width: 800, height: 600, html: "<h1>Hello</h1>" };
  const overwrite = (canvas: DesignCanvas) =>
    writeFile(join(dir, "design-canvases", `${canvas.id}.orkdes`), JSON.stringify(canvas));

  test("persists documents across service restarts and isolates environments", async () => {
    const canvas = await service.create("env-1", "Product");
    const created = await service.createFrame(canvas.id, "env-1", 1, frame);
    const restarted = new DesignService(dir, () => {});
    expect((await restarted.get(canvas.id, "env-1")).frames).toEqual([created.frame]);
    expect(await restarted.list("env-1")).toEqual([
      { id: canvas.id, name: "Product", revision: 2 },
    ]);
    expect(await restarted.list("env-2")).toEqual([]);
    await expect(restarted.get(canvas.id, "env-2")).rejects.toThrow("not found");
    await expect(restarted.get("../../outside")).rejects.toThrow();
  });
  test("only one concurrent human/agent mutation can win the same revision", async () => {
    const canvas = await service.create("env-1");
    const { frame: created } = await service.createFrame(canvas.id, "env-1", 1, frame);
    const results = await Promise.allSettled([
      service.mutate(canvas.id, "env-1", created.id, 1, { html: "<p>Human</p>" }),
      service.mutate(canvas.id, "env-1", created.id, 1, { html: "<p>Agent</p>" }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect((results[1] as PromiseRejectedResult).reason.message).toContain(
      "Design revision conflict:",
    );
    expect((await service.getFrame(canvas.id, "env-1", created.id)).html).toBe("<p>Human</p>");
    await expect(service.createFrame(canvas.id, "env-1", 1, frame)).rejects.toThrow(
      "Design revision conflict:",
    );
  });
  test("missed events, expired replay, and generation changes recover from snapshots", async () => {
    const canvas = await service.create("env-1");
    const { frame: created } = await service.createFrame(canvas.id, "env-1", 1, frame);
    expect(await service.changes(canvas.id, "env-1", service.generation, 1)).toMatchObject({
      reset: false,
      revision: 2,
      events: [{ revision: 2 }],
    });
    // No client is subscribed while the backend keeps working.
    for (let i = 1; i <= 260; i++)
      await service.mutate(canvas.id, "env-1", created.id, i, { x: i });
    expect(await service.changes(canvas.id, "env-1", service.generation, 1)).toMatchObject({
      reset: true,
      events: [],
      revision: 262,
    });
    const restarted = new DesignService(dir, () => {});
    expect(await restarted.changes(canvas.id, "env-1", service.generation, 262)).toMatchObject({
      reset: true,
    });
    expect((await restarted.get(canvas.id)).frames[0]?.x).toBe(260);
  });
  test("imports portable documents under fresh identities and rejects oversized input", async () => {
    const original = await service.create("env-1", "Portable");
    await service.createFrame(original.id, "env-1", 1, frame);
    const imported = await service.create(
      "env-2",
      "unused",
      JSON.stringify(await service.get(original.id)),
    );
    expect(imported.id).not.toBe(original.id);
    expect(imported.environmentId).toBe("env-2");
    expect(imported.frames[0]?.html).toBe(frame.html);
    await expect(
      service.createFrame(original.id, "env-1", 2, {
        ...frame,
        html: "x".repeat(DESIGN_MAX_HTML_BYTES + 1),
      }),
    ).rejects.toThrow();
    expect((await service.get(original.id)).revision).toBe(2);
  });
  test("UI and MCP share validation, including frame creation and required CAS", async () => {
    const canvas = await service.create("env-1");
    const created = (await runDesignAction(service, "env-1", "create_frame", {
      canvasId: canvas.id,
      expectedRevision: 1,
      ...frame,
    })) as { frame: { id: string } };
    await expect(
      runDesignAction(service, "env-1", "replace_frame_html", {
        canvasId: canvas.id,
        frameId: created.frame.id,
        html: "wrong",
      }),
    ).rejects.toThrow();
    await expect(
      runDesignAction(service, "env-2", "get_frame", {
        canvasId: canvas.id,
        frameId: created.frame.id,
      }),
    ).rejects.toThrow("not found");
    expect(Object.keys(designActions(service, "env-1"))).toEqual(
      expect.arrayContaining(["get_canvas_state", "history_status", "undo", "redo"]),
    );
    expect(
      await runDesignAction(service, "env-1", "history_status", { canvasId: canvas.id }),
    ).toMatchObject({
      revision: 2,
      undoCount: 1,
      canUndo: true,
    });
    expect(
      await runDesignAction(service, "env-1", "get_canvas_state", { canvasId: canvas.id }),
    ).toMatchObject({
      canvas: { id: canvas.id, revision: 2 },
      history: { revision: 2, undoCount: 1 },
    });
    await expect(
      runDesignAction(service, "env-1", "undo", { canvasId: canvas.id }),
    ).rejects.toThrow();
    await runDesignAction(service, "env-1", "undo", {
      canvasId: canvas.id,
      expectedRevision: 2,
    });
    await runDesignAction(service, "env-1", "redo", {
      canvasId: canvas.id,
      expectedRevision: 3,
    });
  });

  test("stores frame before/after history and restores it with monotonic revisions", async () => {
    const canvas = await service.create("env-1");
    const { frame: created } = await service.createFrame(canvas.id, "env-1", 1, frame);
    await service.mutate(canvas.id, "env-1", created.id, 1, { html: "<p>After</p>" });
    expect(await service.historyStatus(canvas.id, "env-1")).toEqual({
      revision: 3,
      undoCount: 2,
      redoCount: 0,
      canUndo: true,
      canRedo: false,
    });

    await expect(service.undo(canvas.id, "env-1", 2)).rejects.toThrow("revision conflict");
    await service.undo(canvas.id, "env-1", 3);
    expect(await service.getFrame(canvas.id, "env-1", created.id)).toMatchObject({
      html: frame.html,
      revision: 3,
    });
    await service.undo(canvas.id, "env-1", 4);
    expect((await service.get(canvas.id, "env-1")).frames).toEqual([]);
    expect(await service.historyStatus(canvas.id, "env-1")).toMatchObject({
      revision: 5,
      undoCount: 0,
      redoCount: 2,
      canUndo: false,
      canRedo: true,
    });

    await service.redo(canvas.id, "env-1", 5);
    expect(await service.getFrame(canvas.id, "env-1", created.id)).toMatchObject({
      html: frame.html,
      revision: 4,
    });
    await service.redo(canvas.id, "env-1", 6);
    expect(await service.getFrame(canvas.id, "env-1", created.id)).toMatchObject({
      html: "<p>After</p>",
      revision: 5,
    });
    await expect(service.redo(canvas.id, "env-1", 7)).rejects.toThrow("Nothing to redo");
  });

  test("keeps only ten undo steps and clears redo after a new edit", async () => {
    const canvas = await service.create("env-1");
    const { frame: created } = await service.createFrame(canvas.id, "env-1", 1, frame);
    for (let value = 1; value <= 11; value++)
      await service.mutate(canvas.id, "env-1", created.id, value, { x: value });
    expect(await service.historyStatus(canvas.id, "env-1")).toMatchObject({
      revision: 13,
      undoCount: 10,
      redoCount: 0,
    });

    for (let revision = 13; revision < 23; revision++)
      await service.undo(canvas.id, "env-1", revision);
    expect((await service.getFrame(canvas.id, "env-1", created.id)).x).toBe(1);
    await expect(service.undo(canvas.id, "env-1", 23)).rejects.toThrow("Nothing to undo");

    await service.redo(canvas.id, "env-1", 23);
    const redone = await service.getFrame(canvas.id, "env-1", created.id);
    expect(redone.x).toBe(2);
    await service.mutate(canvas.id, "env-1", created.id, redone.revision, { x: 99 });
    expect(await service.historyStatus(canvas.id, "env-1")).toMatchObject({
      revision: 25,
      undoCount: 2,
      redoCount: 0,
      canRedo: false,
    });
  });

  test("keeps interleaved frame history ordered when the oldest creation is evicted", async () => {
    const canvas = await service.create("env-1");
    const first = await service.createFrame(canvas.id, "env-1", 1, { ...frame, name: "First" });
    const second = await service.createFrame(canvas.id, "env-1", 2, {
      ...frame,
      name: "Second",
    });
    for (let value = 1; value <= 9; value++)
      await service.mutate(canvas.id, "env-1", first.frame.id, value, { x: value });
    expect(await service.historyStatus(canvas.id, "env-1")).toMatchObject({
      revision: 12,
      undoCount: 10,
    });

    for (let canvasRevision = 12; canvasRevision < 21; canvasRevision++)
      await service.undo(canvas.id, "env-1", canvasRevision);
    expect((await service.getFrame(canvas.id, "env-1", first.frame.id)).x).toBe(0);
    await service.undo(canvas.id, "env-1", 21);
    expect((await service.get(canvas.id, "env-1")).frames.map(({ id }) => id)).toEqual([
      first.frame.id,
    ]);
    await service.redo(canvas.id, "env-1", 22);
    expect((await service.get(canvas.id, "env-1")).frames.map(({ id }) => id)).toEqual([
      first.frame.id,
      second.frame.id,
    ]);
    await service.redo(canvas.id, "env-1", 23);
    expect((await service.getFrame(canvas.id, "env-1", first.frame.id)).x).toBe(1);
  });

  test("rejects every out-of-sync history shape without changing the document", async () => {
    const missingCreatedCanvas = await service.create("env-1", "Missing created frame");
    await service.createFrame(missingCreatedCanvas.id, "env-1", 1, frame);
    await overwrite({ ...(await service.get(missingCreatedCanvas.id)), frames: [] });
    await expect(service.undo(missingCreatedCanvas.id, "env-1", 2)).rejects.toThrow(
      "Design history is out of sync",
    );

    const duplicateCanvas = await service.create("env-1", "Duplicate restored frame");
    const duplicate = await service.createFrame(duplicateCanvas.id, "env-1", 1, frame);
    await service.undo(duplicateCanvas.id, "env-1", 2);
    const duplicateDocument = await service.get(duplicateCanvas.id);
    duplicateDocument.frames.push(duplicate.frame);
    await overwrite(duplicateDocument);
    await expect(service.redo(duplicateCanvas.id, "env-1", 3)).rejects.toThrow(
      "Design history is out of sync",
    );

    const missingUpdatedCanvas = await service.create("env-1", "Missing updated frame");
    const updated = await service.createFrame(missingUpdatedCanvas.id, "env-1", 1, frame);
    await service.mutate(missingUpdatedCanvas.id, "env-1", updated.frame.id, 1, { x: 10 });
    await overwrite({ ...(await service.get(missingUpdatedCanvas.id)), frames: [] });
    await expect(service.undo(missingUpdatedCanvas.id, "env-1", 3)).rejects.toThrow(
      "Design history is out of sync",
    );
  });

  test("scopes every history read and mutation to its environment", async () => {
    const canvas = await service.create("env-1");
    await service.createFrame(canvas.id, "env-1", 1, frame);
    await expect(service.historyStatus(canvas.id, "env-2")).rejects.toThrow(
      "Canvas not found in this environment",
    );
    await expect(service.getCanvasState(canvas.id, "env-2")).rejects.toThrow(
      "Canvas not found in this environment",
    );
    await expect(service.undo(canvas.id, "env-2", 2)).rejects.toThrow(
      "Canvas not found in this environment",
    );
    await expect(service.redo(canvas.id, "env-2", 2)).rejects.toThrow(
      "Canvas not found in this environment",
    );
  });

  test("drops history on deletion and starts empty after restart", async () => {
    const internals = () =>
      service as unknown as {
        histories: Map<string, unknown>;
        historyBytes: number;
      };
    const deleted = await service.create("env-delete");
    await service.createFrame(deleted.id, "env-delete", 1, frame);
    expect(internals().histories.has(deleted.id)).toBe(true);
    await service.delete(deleted.id, "env-delete");
    expect(internals().histories.has(deleted.id)).toBe(false);

    const environmentDeleted = await service.create("env-delete");
    await service.createFrame(environmentDeleted.id, "env-delete", 1, frame);
    expect(internals().historyBytes).toBeGreaterThan(0);
    await service.deleteEnvironment("env-delete");
    expect(internals().histories.has(environmentDeleted.id)).toBe(false);

    const retained = await service.create("env-keep");
    await service.createFrame(retained.id, "env-keep", 1, frame);
    await service.close();
    service = new DesignService(dir, () => {});
    expect(await service.historyStatus(retained.id, "env-keep")).toMatchObject({
      revision: 2,
      undoCount: 0,
      redoCount: 0,
    });
  });

  test("publishes atomic canvas and history snapshots without an extra document read", async () => {
    const stateReads: Array<Promise<DesignCanvasState>> = [];
    await service.close();
    service = new DesignService(dir, (event, payload) => {
      if (event !== "design-canvas-changed") return;
      stateReads.push(service.getCanvasState((payload as { canvasId: string }).canvasId, "env-1"));
    });
    const canvas = await service.create("env-1");
    await service.createFrame(canvas.id, "env-1", 1, frame);
    const snapshots = await Promise.all(stateReads);
    expect(snapshots.map(({ canvas, history }) => [canvas.revision, history.revision])).toEqual([
      [1, 1],
      [2, 2],
    ]);
    expect(snapshots[1]?.history.undoCount).toBe(1);

    const originalGet = service.get.bind(service);
    let reads = 0;
    service.get = async (...args) => {
      reads++;
      return originalGet(...args);
    };
    await service.getCanvasState(canvas.id, "env-1");
    await service.historyStatus(canvas.id, "env-1");
    expect(reads).toBe(1);
  });

  test("stores sparse updates and evicts least-recently-used history under a byte budget", async () => {
    const largeA = "a".repeat(DESIGN_MAX_HTML_BYTES);
    const largeB = "b".repeat(DESIGN_MAX_HTML_BYTES);
    const canvases: DesignCanvas[] = [];
    for (let index = 0; index < 4; index++) {
      const canvas = await service.create("env-1", `Large ${index}`);
      canvases.push(canvas);
      const created = await service.createFrame(canvas.id, "env-1", 1, {
        ...frame,
        html: largeA,
      });
      for (let revision = 1; revision <= 10; revision++)
        await service.mutate(canvas.id, "env-1", created.frame.id, revision, {
          html: revision % 2 ? largeB : largeA,
        });
    }
    const internals = service as unknown as { historyBytes: number };
    expect(internals.historyBytes).toBeLessThanOrEqual(DESIGN_HISTORY_MAX_BYTES);
    expect(await service.historyStatus(canvases[0]!.id, "env-1")).toMatchObject({
      undoCount: 0,
      canUndo: false,
    });
    expect(await service.historyStatus(canvases.at(-1)!.id, "env-1")).toMatchObject({
      undoCount: 10,
      canUndo: true,
    });

    const sparse = await service.create("env-1", "Sparse geometry");
    const created = await service.createFrame(sparse.id, "env-1", 1, {
      ...frame,
      html: largeA,
    });
    for (let revision = 1; revision <= 11; revision++)
      await service.mutate(sparse.id, "env-1", created.frame.id, revision, { x: revision });
    const history = (
      service as unknown as {
        histories: Map<string, { undo: unknown[] }>;
      }
    ).histories.get(sparse.id)!;
    expect(JSON.stringify(history.undo)).not.toContain(largeA.slice(0, 100));
  });

  test("reports the frame cap when an external edit fills a canvas before redo", async () => {
    const canvas = await service.create("env-1");
    let revision = 1;
    for (let index = 0; index < DESIGN_MAX_FRAMES; index++) {
      await service.createFrame(canvas.id, "env-1", revision, { ...frame, name: `Frame ${index}` });
      revision++;
    }
    await service.undo(canvas.id, "env-1", revision);
    revision++;
    const document = await service.get(canvas.id, "env-1");
    document.frames.push({ ...frame, id: crypto.randomUUID(), revision: 1 });
    document.revision++;
    await overwrite(document);
    await expect(service.redo(canvas.id, "env-1", revision + 1)).rejects.toThrow(
      `Frame limit reached (${DESIGN_MAX_FRAMES})`,
    );
  });

  test("skips unreadable files without hiding healthy canvases", async () => {
    const canvas = await service.create("env-1", "Healthy");
    await service.close();
    const root = join(dir, "design-canvases");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "not-a-uuid.orkdes"), "{}");
    await writeFile(join(root, `${crypto.randomUUID()}.orkdes`), "{not-json");
    service = new DesignService(dir, () => {});

    expect(await service.list("env-1")).toEqual([{ id: canvas.id, name: "Healthy", revision: 1 }]);
  });

  test("deleting canvases and environments reclaims the global quota across restart", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 256; index++) {
      ids.push((await service.create(index % 2 ? "env-keep" : "env-delete", `Canvas ${index}`)).id);
    }
    await expect(service.create("env-keep", "Over quota")).rejects.toThrow("Canvas limit");
    await service.delete(ids[1]!, "env-keep");
    await expect(service.create("env-keep", "Reclaimed one")).resolves.toMatchObject({
      name: "Reclaimed one",
    });
    expect(await service.deleteEnvironment("env-delete")).toBe(128);
    await service.close();
    service = new DesignService(dir, () => {});
    await service.initialize();
    expect(service.hasCanvases("env-delete")).toBe(false);
    await expect(service.create("env-keep", "After restart")).resolves.toMatchObject({
      name: "After restart",
    });
  });

  test("answers current change cursors from metadata without rereading the document", async () => {
    const canvas = await service.create("env-1");
    const originalGet = service.get.bind(service);
    let reads = 0;
    service.get = async (...args) => {
      reads++;
      return originalGet(...args);
    };
    for (let index = 0; index < 5; index++) {
      expect(await service.changes(canvas.id, "env-1", service.generation, 1)).toMatchObject({
        revision: 1,
        reset: false,
      });
    }
    expect(reads).toBe(0);
  });

  test("bounds the pending write queue and recovers after work settles", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    await service.close();
    service = new DesignService(dir, () => {}, {
      status: () => ({ ready: true }),
      run: async (frame: { html: string }) => {
        await blocked;
        return frame.html;
      },
      close: async () => {},
    } as never);
    const canvas = await service.create("env-1");
    const { frame: created } = await service.createFrame(canvas.id, "env-1", 1, frame);
    const writes = Array.from({ length: 32 }, () =>
      service.mutate(canvas.id, "env-1", created.id, 1, {
        op: "appendHtml" as const,
        html: "<p>x</p>",
      }),
    );
    await expect(service.mutate(canvas.id, "env-1", created.id, 1, { x: 2 })).rejects.toThrow(
      "queue full",
    );
    release();
    const results = await Promise.allSettled(writes);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    await expect(
      service.mutate(canvas.id, "env-1", created.id, 2, { x: 3 }),
    ).resolves.toBeDefined();
  });
});
