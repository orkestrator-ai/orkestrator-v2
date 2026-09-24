import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { DesignCanvas, DesignFrame } from "@orkestrator/protocol/design-canvas";
import {
  DESIGN_LIMITS,
  type DesignSyncDelta,
  type DesignSyncResult,
} from "@orkestrator/protocol/design-operations";
import {
  createDesignHarness,
  deferred,
  trackUnhandledRejections,
  type DesignHarness,
} from "./design-test-support.js";
import { validate } from "./design-validation.js";

const frameInput = { name: "Frame", x: 0, y: 0, width: 400, height: 300, html: "<h1>Frame</h1>" };

/** Installs a delta exactly as a client would; any gap throws. */
function install(base: DesignCanvas, delta: DesignSyncResult): DesignCanvas {
  if (delta.kind !== "delta") throw new Error(`expected a delta, got ${delta.kind}`);
  expect(delta.baseRevision).toBe(base.revision);
  const frames = new Map<string, DesignFrame>(base.frames.map((frame) => [frame.id, { ...frame }]));
  const ids = [...delta.added, ...delta.patched].map((patch) => patch.id);
  expect(new Set([...ids, ...delta.removed]).size).toBe(ids.length + delta.removed.length);
  for (const id of delta.removed) {
    expect(frames.has(id)).toBe(true);
    frames.delete(id);
  }
  for (const patch of delta.added) {
    expect(frames.has(patch.id)).toBe(false);
    expect(patch.html).toBeDefined();
  }
  for (const patch of [...delta.added, ...delta.patched]) {
    const previous = frames.get(patch.id);
    frames.set(patch.id, {
      id: patch.id,
      name: patch.name ?? previous!.name,
      x: patch.x ?? previous!.x,
      y: patch.y ?? previous!.y,
      width: patch.width ?? previous!.width,
      height: patch.height ?? previous!.height,
      html: patch.html ?? previous!.html,
      revision: patch.revision,
    });
  }
  const order =
    delta.canvas?.order ?? base.frames.map((frame) => frame.id).filter((id) => frames.has(id));
  expect(order.length).toBe(frames.size);
  return {
    ...base,
    name: delta.canvas?.name ?? base.name,
    revision: delta.revision,
    frames: order.map((id) => frames.get(id)!),
  };
}

describe("design incremental sync", () => {
  let harness: DesignHarness;
  const rejections = trackUnhandledRejections();
  const service = () => harness.service;

  beforeEach(async () => {
    rejections.install();
    harness = await createDesignHarness({ prefix: "ork-design-sync-" });
  });
  afterEach(async () => {
    await harness.close();
    rejections.remove();
    expect(rejections.seen).toEqual([]);
    rejections.seen.length = 0;
  });

  const setup = async (frames = 2) => {
    const canvas = await service().create("env-1", "Sync", undefined, "user");
    const ids: string[] = [];
    for (let index = 0; index < frames; index++) {
      const created = await service().createFrame(
        canvas.id,
        "env-1",
        index + 1,
        { ...frameInput, name: `Frame ${index}`, html: `<h1>Frame ${index}</h1>` },
        "user",
      );
      ids.push(created.frame.id);
    }
    return { canvasId: canvas.id, ids, base: await service().get(canvas.id, "env-1") };
  };
  const statusVersionOf = async (canvasId: string) => {
    const snapshot = await service().snapshot("env-1", canvasId);
    if (snapshot.kind !== "snapshot") throw new Error(snapshot.kind);
    return snapshot.workspace.statusVersion;
  };
  const sync = (
    canvasId: string,
    after: number,
    statusVersion?: number,
    generation: string = service().generation,
  ) => service().sync("env-1", canvasId, generation, after, statusVersion);

  test("move and rename produce a delta without any HTML", async () => {
    const { canvasId, ids, base } = await setup();
    const statusVersion = await statusVersionOf(canvasId);
    await service().mutate(canvasId, "env-1", ids[0]!, 1, { x: 120, y: 40 }, "user");
    await service().mutate(canvasId, "env-1", ids[0]!, 2, { name: "Renamed" }, "user");
    const delta = (await sync(canvasId, base.revision, statusVersion)) as DesignSyncDelta;
    expect(delta).toMatchObject({
      kind: "delta",
      baseRevision: base.revision,
      revision: base.revision + 2,
    });
    expect(delta.added).toEqual([]);
    expect(delta.removed).toEqual([]);
    expect(delta.patched).toHaveLength(1);
    expect(delta.patched[0]).toMatchObject({
      id: ids[0],
      x: 120,
      y: 40,
      name: "Renamed",
      revision: 3,
    });
    expect(delta.patched[0]).not.toHaveProperty("html");
    expect(JSON.stringify(delta)).not.toContain("<h1>");
    // Geometry keeps content and structure identities.
    const before = (await service().snapshot("env-1", canvasId)) as {
      workspace: { frames: Record<string, { contentId: string }> };
    };
    expect(delta.patched[0]!.identity.contentId).toBe(before.workspace.frames[ids[0]!]!.contentId);
    expect(install(base, delta)).toEqual(await service().get(canvasId, "env-1"));
  });

  test("a style edit transfers HTML only for the changed frame", async () => {
    const { canvasId, ids, base } = await setup(3);
    await service().mutate(
      canvasId,
      "env-1",
      ids[1]!,
      1,
      { op: "setStyles", selector: "h1", styles: { color: "red" } },
      "user",
    );
    const delta = await sync(canvasId, base.revision, await statusVersionOf(canvasId));
    if (delta.kind !== "delta") throw new Error(delta.kind);
    expect(delta.patched.map((patch) => patch.id)).toEqual([ids[1]!]);
    expect(delta.patched[0]!.html).toContain("red");
    expect(JSON.stringify(delta)).not.toContain("Frame 0");
    expect(JSON.stringify(delta)).not.toContain("Frame 2");
    expect(install(base, delta)).toEqual(await service().get(canvasId, "env-1"));
  });

  test("creates, deletes and restores across a range reconcile without ghosts", async () => {
    const { canvasId, ids, base } = await setup(3);
    const run = async (
      input: Parameters<DesignHarness["service"]["runOnce"]>[2]["input"],
      preconditions = {},
    ) => service().runOnce("env-1", "user", { canvasId, input, preconditions });
    const current = async () => (await service().get(canvasId, "env-1")).revision;
    const added = await run(
      { kind: "create_frame", frame: { ...frameInput, name: "Added" } },
      { canvasRevision: await current() },
    );
    const transient = await run(
      { kind: "create_frame", frame: { ...frameInput, name: "Transient" } },
      { canvasRevision: await current() },
    );
    await run(
      { kind: "delete_frame", frameId: transient.result!.createdFrameId! },
      { frameRevision: 1 },
    );
    await run({ kind: "delete_frame", frameId: ids[0]! }, { frameRevision: 1 });
    await run({ kind: "delete_frame", frameId: ids[1]! }, { frameRevision: 1 });
    // Restoring the last deletion brings back the same identity.
    await service().undo(canvasId, "env-1", await current());
    await service().mutate(canvasId, "env-1", ids[2]!, 1, { x: 5 }, "user");
    const delta = await sync(canvasId, base.revision, 0);
    if (delta.kind !== "delta") throw new Error(delta.kind);
    expect(delta.added.map((patch) => patch.id)).toEqual([added.result!.createdFrameId!]);
    expect(delta.removed).toEqual([ids[0]!]);
    expect(delta.patched.map((patch) => patch.id).sort()).toEqual([ids[1]!, ids[2]!].sort());
    expect(delta.patched.find((patch) => patch.id === ids[2])).not.toHaveProperty("html");
    expect(JSON.stringify(delta)).not.toContain(transient.result!.createdFrameId!);
    // Frame metadata rides along for every added or patched frame.
    for (const patch of [...delta.added, ...delta.patched])
      expect(patch.meta?.contentId).toBe(patch.identity.contentId);
    expect(install(base, delta)).toEqual(await service().get(canvasId, "env-1"));
    // Every intermediate base also installs to the same authoritative state.
    for (let revision = base.revision + 1; revision < (await current()); revision++) {
      const partial = await sync(canvasId, revision, 0);
      expect(partial.kind).toBe("delta");
    }
  });

  test("gaps reset: expired range, future cursor and a new generation", async () => {
    const { canvasId, ids, base } = await setup(1);
    const total = DESIGN_LIMITS.changeDescriptors + 2;
    for (let index = 1; index <= total; index++)
      await service().mutate(canvasId, "env-1", ids[0]!, index, { x: index }, "user");
    const revision = base.revision + total;
    expect(await sync(canvasId, base.revision)).toMatchObject({
      kind: "reset",
      reason: "expired-range",
      revision,
    });
    expect(await sync(canvasId, revision + 1)).toMatchObject({
      kind: "reset",
      reason: "future-cursor",
      revision,
    });
    expect(await sync(canvasId, revision - 1, undefined, "other-generation")).toMatchObject({
      kind: "reset",
      reason: "generation",
    });
    expect(await sync(canvasId, revision - 1, await statusVersionOf(canvasId))).toMatchObject({
      kind: "delta",
      baseRevision: revision - 1,
      revision,
    });
    expect(await sync(canvasId, revision, await statusVersionOf(canvasId))).toMatchObject({
      kind: "unchanged",
      revision,
    });
    const oldGeneration = service().generation;
    const restarted = await harness.restart();
    expect(await restarted.sync("env-1", canvasId, oldGeneration, revision, 0)).toMatchObject({
      kind: "reset",
      reason: "generation",
      revision,
    });
    expect(
      await restarted.sync("env-1", canvasId, restarted.generation, revision - 1, 0),
    ).toMatchObject({
      kind: "delta",
    });
  });

  test("an oversized net change resets with too-large and the snapshot path still works", async () => {
    const { canvasId, ids, base } = await setup(2);
    const big = (marker: string) => `<p>${marker}</p><div>${"x".repeat(150 * 1024)}</div>`;
    await service().mutate(canvasId, "env-1", ids[0]!, 1, { html: big("first") }, "user");
    await service().mutate(canvasId, "env-1", ids[1]!, 1, { html: big("second") }, "user");
    expect(await sync(canvasId, base.revision, 0)).toMatchObject({
      kind: "reset",
      reason: "too-large",
    });
    // One changed frame alone still fits.
    const single = await sync(canvasId, base.revision + 1, 0);
    expect(single.kind).toBe("delta");
    const snapshot = await service().snapshot("env-1", canvasId);
    expect(snapshot).toMatchObject({ kind: "snapshot", canvas: { revision: base.revision + 2 } });
  });

  test("a status-only change surfaces as kind status without a new document revision", async () => {
    const { canvasId, ids } = await setup(1);
    const gate = deferred();
    harness.renderer.block = (job) => (job.priority === "validation" ? gate.promise : undefined);
    await service().mutate(
      canvasId,
      "env-1",
      ids[0]!,
      1,
      { op: "appendHtml", html: "<p>more</p>" },
      "user",
    );
    const document = await service().get(canvasId, "env-1");
    const statusBefore = await statusVersionOf(canvasId);
    const snapshotBefore = await service().snapshot("env-1", canvasId);
    if (snapshotBefore.kind !== "snapshot") throw new Error(snapshotBefore.kind);
    // Appended content is validated in the background after commit.
    expect(snapshotBefore.workspace.frames[ids[0]!]!.validation.state).toBe("unvalidated");
    await harness.renderer.started((job) => job.priority === "validation");
    const eventsBefore = harness.events.length;
    const joined = validate(service(), "env-1", canvasId, ids[0]!);
    gate.resolve();
    expect((await joined)?.state).toBe("valid");
    expect(harness.renderer.jobs.filter((job) => job.priority === "validation")).toHaveLength(1);
    const after = await service().get(canvasId, "env-1");
    expect(after.revision).toBe(document.revision);
    const statusAfter = await statusVersionOf(canvasId);
    expect(statusAfter).toBeGreaterThan(statusBefore);
    expect(harness.events.slice(eventsBefore)).toEqual([
      expect.objectContaining({
        canvasId,
        kind: "status",
        revision: document.revision,
        frameId: ids[0],
      }),
    ]);
    const status = await sync(canvasId, document.revision, statusBefore);
    expect(status).toMatchObject({
      kind: "status",
      revision: document.revision,
      statusVersion: statusAfter,
    });
    if (status.kind !== "status") throw new Error(status.kind);
    expect(status.workspace.frames[ids[0]!]!.validation.state).toBe("valid");
    expect(await sync(canvasId, document.revision, statusAfter)).toMatchObject({
      kind: "unchanged",
    });
    // A later document delta still starts from the unchanged document cursor.
    await service().mutate(
      canvasId,
      "env-1",
      ids[0]!,
      (await service().getFrame(canvasId, "env-1", ids[0]!)).revision,
      { x: 3 },
      "user",
    );
    const delta = await sync(canvasId, document.revision, statusAfter);
    expect(delta).toMatchObject({
      kind: "delta",
      baseRevision: document.revision,
      revision: document.revision + 1,
    });
  });
});
