import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DESIGN_CONFLICT,
  DESIGN_MAX_CANVASES,
  DESIGN_MAX_HTML_BYTES,
} from "@orkestrator/protocol/design-canvas";
import { DESIGN_LIMITS } from "@orkestrator/protocol/design-operations";
import { isDesignError } from "./design-errors.js";
import {
  createDesignHarness,
  deferred,
  trackUnhandledRejections,
  type DesignHarness,
} from "./design-test-support.js";
import { designActions, runDesignAction } from "./design-tools.js";

const frame = { name: "Home", x: 0, y: 0, width: 800, height: 600, html: "<h1>Hello</h1>" };

describe("design service (legacy adapters over prepare/execute)", () => {
  let harness: DesignHarness;
  const rejections = trackUnhandledRejections();
  const service = () => harness.service;

  beforeEach(async () => {
    rejections.install();
    harness = await createDesignHarness({ prefix: "ork-design-service-" });
  });
  afterEach(async () => {
    await harness.close();
    rejections.remove();
    expect(rejections.seen).toEqual([]);
    rejections.seen.length = 0;
  });

  test("persists documents across restarts and isolates environments", async () => {
    const canvas = await service().create("env-1", "Product");
    const created = await service().createFrame(canvas.id, "env-1", 1, frame);
    expect(created.canvasRevision).toBe(2);
    const restarted = await harness.restart();
    expect((await restarted.get(canvas.id, "env-1")).frames).toEqual([created.frame]);
    expect(await restarted.list("env-1")).toEqual([
      { id: canvas.id, name: "Product", revision: 2 },
    ]);
    expect(await restarted.list("env-2")).toEqual([]);
    await expect(restarted.get(canvas.id, "env-2")).rejects.toThrow("not found");
    await expect(restarted.getFrame(canvas.id, "env-2", created.frame.id)).rejects.toThrow(
      "not found",
    );
    await expect(restarted.historyStatus(canvas.id, "env-2")).rejects.toThrow(
      "Canvas not found in this environment",
    );
    await expect(restarted.get("../../outside")).rejects.toThrow();
    expect(await restarted.snapshot("env-2", canvas.id)).toMatchObject({ kind: "missing" });
  });

  test("only one concurrent human/agent mutation wins the same revision", async () => {
    const canvas = await service().create("env-1");
    const { frame: created } = await service().createFrame(canvas.id, "env-1", 1, frame);
    const results = await Promise.allSettled([
      service().mutate(canvas.id, "env-1", created.id, 1, { html: "<p>Human</p>" }, "user"),
      service().mutate(canvas.id, "env-1", created.id, 1, { html: "<p>Agent</p>" }, "agent"),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason.message).toStartWith(DESIGN_CONFLICT);
    expect(isDesignError(rejected[0]!.reason, "conflict")).toBe(true);
    const winner = results[0]!.status === "fulfilled" ? "<p>Human</p>" : "<p>Agent</p>";
    expect((await service().getFrame(canvas.id, "env-1", created.id)).html).toBe(winner);
    await expect(service().createFrame(canvas.id, "env-1", 1, frame)).rejects.toThrow(
      DESIGN_CONFLICT,
    );
    expect((await service().get(canvas.id, "env-1")).revision).toBe(3);
  });

  test("missed events, expired replay and generation changes reset through changes()", async () => {
    const canvas = await service().create("env-1");
    const { frame: created } = await service().createFrame(canvas.id, "env-1", 1, frame);
    expect(await service().changes(canvas.id, "env-1", service().generation, 1)).toMatchObject({
      reset: false,
      revision: 2,
      events: [{ revision: 2, frameId: created.id }],
    });
    const total = DESIGN_LIMITS.changeDescriptors + 4;
    for (let index = 1; index <= total; index++)
      await service().mutate(canvas.id, "env-1", created.id, index, { x: index });
    const current = 2 + total;
    expect(await service().changes(canvas.id, "env-1", service().generation, 1)).toMatchObject({
      reset: true,
      events: [],
      revision: current,
    });
    expect(
      await service().changes(canvas.id, "env-1", service().generation, current - 2),
    ).toMatchObject({
      reset: false,
      events: [{ revision: current - 1 }, { revision: current }],
    });
    expect(
      await service().changes(canvas.id, "env-1", service().generation, current + 1),
    ).toMatchObject({
      reset: true,
    });
    const oldGeneration = service().generation;
    const restarted = await harness.restart();
    expect(restarted.generation).not.toBe(oldGeneration);
    expect(await restarted.changes(canvas.id, "env-1", oldGeneration, current)).toMatchObject({
      reset: true,
      revision: current,
    });
    expect((await restarted.get(canvas.id)).frames[0]?.x).toBe(total);
  });

  test("imports portable documents under fresh identities and rejects oversized input", async () => {
    const original = await service().create("env-1", "Portable");
    const { frame: created } = await service().createFrame(original.id, "env-1", 1, frame);
    const imported = await service().create(
      "env-2",
      "unused",
      JSON.stringify(await service().get(original.id)),
    );
    expect(imported.id).not.toBe(original.id);
    expect(imported.environmentId).toBe("env-2");
    expect(imported.name).toBe("Portable");
    expect(imported.frames).toHaveLength(1);
    expect(imported.frames[0]!.id).not.toBe(created.id);
    expect(imported.frames[0]?.html).toBe(frame.html);
    await expect(
      service().createFrame(original.id, "env-1", 2, {
        ...frame,
        html: "x".repeat(DESIGN_MAX_HTML_BYTES + 1),
      }),
    ).rejects.toThrow();
    await expect(
      service().create("env-1", "Huge", "x".repeat(4 * 1024 * 1024 + 1)),
    ).rejects.toThrow();
    await expect(service().create("env-1", "Bad", "{not json")).rejects.toThrow(
      "not a valid .orkdes",
    );
    await expect(
      service().create("env-1", "Future", JSON.stringify({ format: "orkdes", version: 2 })),
    ).rejects.toThrow("not supported");
    expect((await service().get(original.id)).revision).toBe(2);
    expect(await service().list("env-1")).toHaveLength(1);
  });

  test("UI and MCP share validation, required CAS and per-actor history", async () => {
    const canvas = await service().create("env-1");
    const created = (await runDesignAction(service(), "env-1", "create_frame", {
      canvasId: canvas.id,
      expectedRevision: 1,
      ...frame,
    })) as { frame: { id: string }; canvasRevision: number };
    expect(created.canvasRevision).toBe(2);
    await expect(
      runDesignAction(service(), "env-1", "replace_frame_html", {
        canvasId: canvas.id,
        frameId: created.frame.id,
        html: "missing revision",
      }),
    ).rejects.toThrow();
    await expect(
      runDesignAction(service(), "env-2", "get_frame", {
        canvasId: canvas.id,
        frameId: created.frame.id,
      }),
    ).rejects.toThrow("not found");
    expect(Object.keys(designActions(service(), "env-1"))).toEqual(
      expect.arrayContaining([
        "get_canvas_state",
        "history_status",
        "undo",
        "redo",
        "submit_operation",
        "save_canvas",
      ]),
    );
    // MCP acts as the agent: its own create_frame entry is undoable.
    expect(
      await runDesignAction(service(), "env-1", "history_status", { canvasId: canvas.id }),
    ).toMatchObject({
      revision: 2,
      undoCount: 1,
      canUndo: true,
    });
    // The UI acts as the user, who has nothing of their own to undo.
    expect(
      await runDesignAction(
        service(),
        "env-1",
        "history_status",
        { canvasId: canvas.id },
        { actor: "user" },
      ),
    ).toMatchObject({ revision: 2, undoCount: 0, canUndo: false });
    expect(
      await runDesignAction(service(), "env-1", "get_canvas_state", { canvasId: canvas.id }),
    ).toMatchObject({
      canvas: { id: canvas.id, revision: 2 },
      history: { revision: 2, undoCount: 1 },
    });
    await expect(
      runDesignAction(service(), "env-1", "undo", { canvasId: canvas.id }),
    ).rejects.toThrow();
    await expect(
      runDesignAction(
        service(),
        "env-1",
        "undo",
        { canvasId: canvas.id, expectedRevision: 2 },
        { actor: "user" },
      ),
    ).rejects.toThrow("Nothing to undo");
    await runDesignAction(service(), "env-1", "undo", { canvasId: canvas.id, expectedRevision: 2 });
    expect((await service().get(canvas.id, "env-1")).frames).toEqual([]);
    await runDesignAction(service(), "env-1", "redo", { canvasId: canvas.id, expectedRevision: 3 });
    expect((await service().get(canvas.id, "env-1")).frames.map((item) => item.id)).toEqual([
      created.frame.id,
    ]);
    expect((await service().get(canvas.id, "env-1")).revision).toBe(4);
  });

  test("unreadable files do not hide healthy canvases", async () => {
    const canvas = await service().create("env-1", "Healthy");
    await service().close();
    const root = join(harness.dir, "design-canvases");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "not-a-uuid.orkdes"), "{}");
    await writeFile(join(root, `${crypto.randomUUID()}.orkdes`), "{not-json");
    await writeFile(join(root, `${crypto.randomUUID()}.orkrec`), "{not-json");
    await writeFile(join(root, "index.json"), "{corrupt index");
    const restarted = await harness.restart();
    expect(await restarted.list("env-1")).toEqual([
      { id: canvas.id, name: "Healthy", revision: 1 },
    ]);
    expect((await restarted.get(canvas.id, "env-1")).name).toBe("Healthy");
  });

  test("deleting canvases and environments reclaims the global quota across restart", async () => {
    const ids: string[] = [];
    for (let index = 0; index < DESIGN_MAX_CANVASES; index++)
      ids.push(
        (await service().create(index % 2 ? "env-keep" : "env-delete", `Canvas ${index}`)).id,
      );
    await expect(service().create("env-keep", "Over quota")).rejects.toThrow("Canvas limit");
    await service().delete(ids[1]!, "env-keep");
    await expect(service().create("env-keep", "Reclaimed one")).resolves.toMatchObject({
      name: "Reclaimed one",
    });
    expect(await service().deleteEnvironment("env-delete")).toBe(DESIGN_MAX_CANVASES / 2);
    expect(service().hasCanvases("env-delete")).toBe(false);
    const restarted = await harness.restart();
    await restarted.initialize();
    expect(restarted.hasCanvases("env-delete")).toBe(false);
    expect(restarted.hasCanvases("env-keep")).toBe(true);
    await expect(restarted.create("env-keep", "After restart")).resolves.toMatchObject({
      name: "After restart",
    });
    expect(
      (await restarted.libraryPage("env-keep", { filter: "deleted" })).entries.map(
        (entry) => entry.id,
      ),
    ).toEqual([ids[1]!]);
  }, 60_000);

  test("publishes hints only after the committed state is readable", async () => {
    const observed: Array<Promise<[number, number]>> = [];
    await harness.close();
    harness = await createDesignHarness({ prefix: "ork-design-service-" });
    const reader = harness.service;
    const originalEmit = harness.events.push.bind(harness.events);
    harness.events.push = (...changes) => {
      for (const change of changes)
        observed.push(
          reader
            .snapshot("env-1", change.canvasId)
            .then((snapshot) => [
              change.revision,
              snapshot.kind === "snapshot" ? snapshot.canvas.revision : -1,
            ]),
        );
      return originalEmit(...changes);
    };
    const canvas = await reader.create("env-1");
    await reader.createFrame(canvas.id, "env-1", 1, frame);
    const pairs = await Promise.all(observed);
    expect(pairs.length).toBeGreaterThanOrEqual(2);
    for (const [hinted, readable] of pairs) expect(readable).toBeGreaterThanOrEqual(hinted);
  });

  test("bounds admitted edits per canvas and globally, then recovers", async () => {
    const gate = deferred();
    harness.renderer.block = (job) =>
      job.operation.op === "appendHtml" ? gate.promise : undefined;
    const canvas = await service().create("env-1");
    const { frame: created } = await service().createFrame(canvas.id, "env-1", 1, frame);
    const append = { op: "appendHtml" as const, html: "<p>x</p>" };
    const writes = Array.from({ length: DESIGN_LIMITS.preparedPerCanvas }, () =>
      service().mutate(canvas.id, "env-1", created.id, 1, append),
    );
    await harness.renderer.started(
      (job) => job.op === "appendHtml",
      DESIGN_LIMITS.preparedPerCanvas,
    );
    const overflow = await service()
      .mutate(canvas.id, "env-1", created.id, 1, { x: 2 })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(isDesignError(overflow, "capacity")).toBe(true);
    // Geometry on another canvas is unaffected by this canvas's backlog.
    const other = await service().create("env-1", "Other");
    const otherFrame = await service().createFrame(other.id, "env-1", 1, frame);
    await expect(
      service().mutate(other.id, "env-1", otherFrame.frame.id, 1, { x: 5 }),
    ).resolves.toBeDefined();
    gate.resolve();
    const results = await Promise.allSettled(writes);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results)
      if (result.status === "rejected") expect(isDesignError(result.reason, "conflict")).toBe(true);
    await expect(
      service().mutate(canvas.id, "env-1", created.id, 2, { x: 3 }),
    ).resolves.toBeDefined();
  });

  test("global admission rejects before execution once 32 edits are running", async () => {
    const gate = deferred();
    harness.renderer.block = (job) =>
      job.operation.op === "appendHtml" ? gate.promise : undefined;
    const append = { op: "appendHtml" as const, html: "<p>x</p>" };
    const perCanvas = DESIGN_LIMITS.admittedMutationsPerCanvas;
    const canvases = DESIGN_LIMITS.admittedMutations / perCanvas;
    const targets: Array<{ canvasId: string; frameId: string }> = [];
    for (let index = 0; index < canvases; index++) {
      const canvas = await service().create("env-1", `Busy ${index}`);
      const { frame: created } = await service().createFrame(canvas.id, "env-1", 1, frame);
      targets.push({ canvasId: canvas.id, frameId: created.id });
    }
    const extra = await service().create("env-1", "Extra");
    const extraFrame = await service().createFrame(extra.id, "env-1", 1, frame);
    const writes = targets.flatMap((target) =>
      Array.from({ length: perCanvas }, () =>
        service().mutate(target.canvasId, "env-1", target.frameId, 1, append),
      ),
    );
    try {
      await harness.renderer.started(
        (job) => job.op === "appendHtml",
        DESIGN_LIMITS.admittedMutations,
      );
      // Every admission path counts, including lifecycle operations.
      const refused = await Promise.allSettled([
        service().mutate(extra.id, "env-1", extraFrame.frame.id, 1, { x: 1 }),
        service().create("env-1", "Refused"),
      ]);
      for (const result of refused) {
        expect(result.status).toBe("rejected");
        expect(isDesignError((result as PromiseRejectedResult).reason, "capacity")).toBe(true);
      }
      expect((await service().getFrame(extra.id, "env-1", extraFrame.frame.id)).x).toBe(0);
    } finally {
      gate.resolve();
    }
    gate.resolve();
    await Promise.allSettled(writes);
    await expect(
      service().mutate(extra.id, "env-1", extraFrame.frame.id, 1, { x: 1 }),
    ).resolves.toBeDefined();
  }, 30_000);
});
