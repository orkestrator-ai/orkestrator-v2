import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DESIGN_LIMITS,
  type DesignOperationDescriptor,
} from "@orkestrator/protocol/design-operations";
import { isDesignError } from "./design-errors.js";
import { PROTECTED_HISTORY_ENTRIES } from "./design-history.js";
import type { DesignPrivateRecord } from "./design-records.js";
import {
  createDesignHarness,
  trackUnhandledRejections,
  type DesignHarness,
} from "./design-test-support.js";

const frameInput = { name: "Card", x: 0, y: 0, width: 400, height: 300, html: "<h1>Title</h1>" };

describe("design history: per-actor undo/redo, checkpoints and budgets", () => {
  let harness: DesignHarness;
  const faults: { beforeRename?: (file: string) => void } = {};
  const rejections = trackUnhandledRejections();
  const service = () => harness.service;
  const serviceOptions = () => ({
    faults: { beforeRename: (file: string) => faults.beforeRename?.(file) },
  });

  beforeEach(async () => {
    rejections.install();
    delete faults.beforeRename;
    harness = await createDesignHarness({
      prefix: "ork-design-history-",
      service: serviceOptions(),
    });
  });
  afterEach(async () => {
    delete faults.beforeRename;
    await harness.close();
    rejections.remove();
    expect(rejections.seen).toEqual([]);
    rejections.seen.length = 0;
  });

  /** A canvas with two frames created by the agent (so user history starts empty). */
  const setup = async () => {
    const canvas = await service().create("env-1", "History", undefined, "agent");
    const a = await service().createFrame(
      canvas.id,
      "env-1",
      1,
      { ...frameInput, name: "A" },
      "agent",
    );
    const b = await service().createFrame(
      canvas.id,
      "env-1",
      2,
      { ...frameInput, name: "B", x: 500 },
      "agent",
    );
    return { canvasId: canvas.id, a: a.frame.id, b: b.frame.id };
  };
  const revisionOf = async (canvasId: string) => (await service().get(canvasId, "env-1")).revision;
  const frameOf = (canvasId: string, frameId: string) =>
    service().getFrame(canvasId, "env-1", frameId);
  const styleA = async (
    canvasId: string,
    frameId: string,
    color: string,
    actor: "user" | "agent" = "user",
  ) => {
    const current = await frameOf(canvasId, frameId);
    return service().mutate(
      canvasId,
      "env-1",
      frameId,
      current.revision,
      { op: "setStyles", selector: "h1", styles: { color } },
      actor,
    );
  };
  const moveFrame = async (
    canvasId: string,
    frameId: string,
    x: number,
    actor: "user" | "agent",
  ) => {
    const current = await frameOf(canvasId, frameId);
    return service().mutate(canvasId, "env-1", frameId, current.revision, { x }, actor);
  };
  const failureOf = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: unknown) => error,
    );
  const recordOf = async (canvasId: string) =>
    JSON.parse(await readFile(service().store.recordFile(canvasId), "utf8")) as DesignPrivateRecord;

  test("undo is per actor and preserves unrelated frame changes", async () => {
    const { canvasId, a, b } = await setup();
    await styleA(canvasId, a, "red", "user");
    await moveFrame(canvasId, b, 900, "agent");
    expect(await service().historyStatus(canvasId, "env-1", "user")).toMatchObject({
      canUndo: true,
      undoCount: 1,
    });
    const beforeUndo = await revisionOf(canvasId);
    const aRevision = (await frameOf(canvasId, a)).revision;
    await service().undo(canvasId, "env-1", beforeUndo);
    expect((await frameOf(canvasId, a)).html).not.toContain("red");
    expect((await frameOf(canvasId, a)).revision).toBe(aRevision + 1);
    // The agent's unrelated move survives the user's undo.
    expect((await frameOf(canvasId, b)).x).toBe(900);
    expect(await revisionOf(canvasId)).toBe(beforeUndo + 1);
    // The agent undoes only its own latest edit.
    await service().undo(canvasId, "env-1", beforeUndo + 1, "agent");
    expect((await frameOf(canvasId, b)).x).toBe(500);
    expect((await frameOf(canvasId, a)).html).not.toContain("red");
  });

  test("undo is refused when another actor changed the same target, without changing anything", async () => {
    const { canvasId, a } = await setup();
    await styleA(canvasId, a, "red", "user");
    await moveFrame(canvasId, a, 77, "agent");
    const status = await service().historyStatus(canvasId, "env-1", "user");
    expect(status).toMatchObject({ canUndo: false });
    expect(status.undoBlockedReason).toContain("changed after this edit");
    const before = await service().get(canvasId, "env-1");
    const error = await failureOf(service().undo(canvasId, "env-1", before.revision));
    expect(isDesignError(error, "history-ineligible")).toBe(true);
    expect(await service().get(canvasId, "env-1")).toEqual(before);
    // The typed path reports the same outcome as a rejected receipt.
    const prepared = await service().prepare("env-1", "user", {
      canvasId,
      input: { kind: "undo" },
      preconditions: { canvasRevision: before.revision },
    });
    expect(await service().execute("env-1", canvasId, prepared.token)).toMatchObject({
      state: "rejected",
      failure: { code: "history-ineligible" },
    });
  });

  test("canvas-scope entries need the exact canvas revision", async () => {
    const { canvasId, b } = await setup();
    const rename = await service().runOnce("env-1", "user", {
      canvasId,
      input: { kind: "rename_canvas", name: "Renamed" },
      preconditions: { canvasRevision: await revisionOf(canvasId) },
    });
    expect(rename.state).toBe("committed");
    expect((await service().historyStatus(canvasId, "env-1", "user")).canUndo).toBe(true);
    await moveFrame(canvasId, b, 10, "agent");
    expect((await service().historyStatus(canvasId, "env-1", "user")).canUndo).toBe(false);
    const error = await failureOf(service().undo(canvasId, "env-1", await revisionOf(canvasId)));
    expect(isDesignError(error, "history-ineligible")).toBe(true);
    expect((await service().get(canvasId, "env-1")).name).toBe("Renamed");
  });

  test("multi-level undo and redo on the same frame, with monotonic revisions", async () => {
    const { canvasId, a } = await setup();
    await styleA(canvasId, a, "red");
    await styleA(canvasId, a, "blue");
    await moveFrame(canvasId, a, 30, "user");
    const revisions: number[] = [await revisionOf(canvasId)];
    const frameRevisions: number[] = [(await frameOf(canvasId, a)).revision];
    const step = async (kind: "undo" | "redo") => {
      await service()[kind](canvasId, "env-1", revisions.at(-1)!);
      revisions.push(await revisionOf(canvasId));
      frameRevisions.push((await frameOf(canvasId, a)).revision);
    };
    await step("undo");
    expect((await frameOf(canvasId, a)).x).toBe(0);
    await step("undo");
    expect((await frameOf(canvasId, a)).html).toContain("red");
    await step("undo");
    expect((await frameOf(canvasId, a)).html).not.toContain("red");
    expect(await service().historyStatus(canvasId, "env-1", "user")).toMatchObject({
      canUndo: false,
      canRedo: true,
    });
    await step("redo");
    expect((await frameOf(canvasId, a)).html).toContain("red");
    await step("redo");
    expect((await frameOf(canvasId, a)).html).toContain("blue");
    await step("redo");
    expect((await frameOf(canvasId, a)).x).toBe(30);
    expect(await service().historyStatus(canvasId, "env-1", "user")).toMatchObject({
      canRedo: false,
      canUndo: true,
    });
    const error = await failureOf(service().redo(canvasId, "env-1", revisions.at(-1)!));
    expect(isDesignError(error, "history-ineligible")).toBe(true);
    for (let index = 1; index < revisions.length; index++) {
      expect(revisions[index]!).toBe(revisions[index - 1]! + 1);
      expect(frameRevisions[index]!).toBe(frameRevisions[index - 1]! + 1);
    }
  });

  test("undo chains through a deleted and restored frame", async () => {
    const { canvasId, a } = await setup();
    await styleA(canvasId, a, "red");
    const deleted = await service().runOnce("env-1", "user", {
      canvasId,
      input: { kind: "delete_frame", frameId: a },
      preconditions: { frameRevision: (await frameOf(canvasId, a)).revision },
    });
    expect(deleted.state).toBe("committed");
    await service().undo(canvasId, "env-1", await revisionOf(canvasId));
    expect((await frameOf(canvasId, a)).html).toContain("red");
    await service().undo(canvasId, "env-1", await revisionOf(canvasId));
    expect((await frameOf(canvasId, a)).html).not.toContain("red");
    expect(await service().historyStatus(canvasId, "env-1", "user")).toMatchObject({
      canRedo: true,
      redoCount: 2,
    });
    await service().redo(canvasId, "env-1", await revisionOf(canvasId));
    await service().redo(canvasId, "env-1", await revisionOf(canvasId));
    await expect(frameOf(canvasId, a)).rejects.toThrow("Frame not found");
  });

  test("a new edit by the same actor invalidates redo; another actor's edit elsewhere does not", async () => {
    const { canvasId, a, b } = await setup();
    await styleA(canvasId, a, "red");
    await service().undo(canvasId, "env-1", await revisionOf(canvasId));
    await moveFrame(canvasId, b, 42, "agent");
    expect(await service().historyStatus(canvasId, "env-1", "user")).toMatchObject({
      canRedo: true,
    });
    await moveFrame(canvasId, b, 43, "user");
    expect(await service().historyStatus(canvasId, "env-1", "user")).toMatchObject({
      canRedo: false,
      redoCount: 0,
    });
    const error = await failureOf(service().redo(canvasId, "env-1", await revisionOf(canvasId)));
    expect(isDesignError(error, "history-ineligible")).toBe(true);
    expect((await frameOf(canvasId, a)).html).not.toContain("red");
  });

  test("history survives restart and counters never decrease", async () => {
    const { canvasId, a } = await setup();
    await styleA(canvasId, a, "red");
    await moveFrame(canvasId, a, 12, "user");
    const before = await revisionOf(canvasId);
    let restarted = await harness.restart(serviceOptions());
    expect(await restarted.historyStatus(canvasId, "env-1", "user")).toMatchObject({
      canUndo: true,
      undoCount: 2,
    });
    await restarted.undo(canvasId, "env-1", before);
    expect((await restarted.getFrame(canvasId, "env-1", a)).x).toBe(0);
    restarted = await harness.restart(serviceOptions());
    expect(await restarted.historyStatus(canvasId, "env-1", "user")).toMatchObject({
      canRedo: true,
    });
    await restarted.redo(canvasId, "env-1", before + 1);
    const current = await restarted.get(canvasId, "env-1");
    expect(current.revision).toBe(before + 2);
    expect(current.frames.find((frame) => frame.id === a)!.x).toBe(12);
    const page = await restarted.historyPage("env-1", canvasId);
    expect(page.entries[0]).toMatchObject({ actor: "user" });
    const newestFirst = page.entries.map((entry) => entry.canvasRevisionAfter);
    expect(newestFirst).toEqual(newestFirst.toSorted((x, y) => y - x));
  });

  test("a gesture merges into one history entry", async () => {
    const { canvasId, a } = await setup();
    const entries = (await service().historyPage("env-1", canvasId)).total;
    for (const x of [10, 20, 30]) {
      const current = await frameOf(canvasId, a);
      const descriptor: DesignOperationDescriptor = {
        canvasId,
        input: { kind: "update_frame", frameId: a, patch: { x } },
        preconditions: { frameRevision: current.revision },
        gestureId: "drag-1",
      };
      expect((await service().runOnce("env-1", "user", descriptor)).state).toBe("committed");
    }
    const page = await service().historyPage("env-1", canvasId);
    expect(page.total).toBe(entries + 1);
    expect(page.entries[0]).toMatchObject({ gestureId: "drag-1", actor: "user" });
    await service().undo(canvasId, "env-1", await revisionOf(canvasId));
    expect((await frameOf(canvasId, a)).x).toBe(0);
  });

  test("restore_checkpoint creates a new revision and a history entry", async () => {
    const { canvasId, a } = await setup();
    await styleA(canvasId, a, "red", "agent");
    await styleA(canvasId, a, "blue", "agent");
    const page = await service().historyPage("env-1", canvasId);
    const redEntry = page.entries.find(
      (entry) => entry.label.startsWith("Change styles") && entry.frames[0]?.before === 1,
    );
    expect(redEntry).toBeDefined();
    const preview = await service().checkpoint("env-1", canvasId, redEntry!.id, "after");
    expect(preview.frames[0]!.frame!.html).toContain("red");
    const before = await service().get(canvasId, "env-1");
    const beforeFrame = before.frames.find((frame) => frame.id === a)!;
    const restored = await service().runOnce("env-1", "user", {
      canvasId,
      input: { kind: "restore_checkpoint", entryId: redEntry!.id, side: "after" },
      preconditions: { canvasRevision: before.revision },
    });
    expect(restored.state).toBe("committed");
    const after = await frameOf(canvasId, a);
    expect(after.html).toContain("red");
    expect(after.html).not.toContain("blue");
    expect(after.revision).toBe(beforeFrame.revision + 1);
    expect(await revisionOf(canvasId)).toBe(before.revision + 1);
    expect((await service().historyPage("env-1", canvasId)).entries[0]).toMatchObject({
      kind: "restore_checkpoint",
      actor: "user",
    });
    // Restoring against a stale canvas revision is a conflict.
    const stale = await failureOf(
      service().runOnce("env-1", "user", {
        canvasId,
        input: { kind: "restore_checkpoint", entryId: redEntry!.id, side: "before" },
        preconditions: { canvasRevision: before.revision },
      }),
    );
    expect(isDesignError(stale, "conflict")).toBe(true);
  });

  test("the per-canvas entry budget prunes the oldest entries and their checkpoint files", async () => {
    const { canvasId, a } = await setup();
    const edits = DESIGN_LIMITS.historyEntriesPerCanvas + 5;
    for (let index = 1; index <= edits; index++) await moveFrame(canvasId, a, index, "user");
    const page = await service().historyPage("env-1", canvasId, 0, 100);
    expect(page.total).toBe(DESIGN_LIMITS.historyEntriesPerCanvas);
    expect(page.entries.filter((entry) => entry.protected)).toHaveLength(PROTECTED_HISTORY_ENTRIES);
    expect(page.entries.every((entry) => entry.actor === "user")).toBe(true);
    const record = await recordOf(canvasId);
    await service().close();
    const files = await readdir(service().store.historyDir(canvasId));
    expect(files.sort()).toEqual(record.history.entries.map((entry) => entry.checkpoint).sort());
  });

  /** Temporarily lowers a history budget (DESIGN_LIMITS is a plain object at runtime). */
  const withLimit = async (
    key: "historyBytesPerCanvas" | "historyBytesGlobal",
    value: number,
    work: () => Promise<void>,
  ) => {
    const limits = DESIGN_LIMITS as unknown as Record<string, number>;
    const previous = limits[key]!;
    limits[key] = value;
    try {
      await work();
    } finally {
      limits[key] = previous;
    }
  };

  test("the per-canvas byte budget prunes old entries and refuses what it cannot keep undoable", async () => {
    const { canvasId, a } = await setup();
    for (let index = 1; index <= 4; index++) await moveFrame(canvasId, a, index, "user");
    const perEntry = Math.max(
      ...(await service().historyPage("env-1", canvasId)).entries.map((entry) => entry.bytes),
    );
    await withLimit(
      "historyBytesPerCanvas",
      perEntry * (PROTECTED_HISTORY_ENTRIES + 1),
      async () => {
        for (let index = 5; index <= 8; index++) await moveFrame(canvasId, a, index, "user");
        const page = await service().historyPage("env-1", canvasId);
        expect(page.bytes).toBeLessThanOrEqual(perEntry * (PROTECTED_HISTORY_ENTRIES + 1));
        expect(page.total).toBeGreaterThanOrEqual(PROTECTED_HISTORY_ENTRIES);
        expect(page.total).toBeLessThan(10);
        // A large replacement whose checkpoint cannot fit beside the protected entries is refused up front.
        const before = await service().get(canvasId, "env-1");
        const html = `<p>${"y".repeat(perEntry * 4)}</p>`;
        const refused = await failureOf(
          service().mutate(
            canvasId,
            "env-1",
            a,
            (await frameOf(canvasId, a)).revision,
            { html },
            "user",
          ),
        );
        expect(isDesignError(refused, "capacity")).toBe(true);
        expect(await service().get(canvasId, "env-1")).toEqual(before);
        expect((await service().historyPage("env-1", canvasId)).total).toBe(page.total);
      },
    );
    await service().close();
    const record = await recordOf(canvasId);
    expect((await readdir(service().store.historyDir(canvasId))).sort()).toEqual(
      record.history.entries.map((entry) => entry.checkpoint).sort(),
    );
  });

  test("the global byte budget prunes the oldest unprotected entries across canvases", async () => {
    const first = await setup();
    for (let index = 1; index <= 6; index++)
      await moveFrame(first.canvasId, first.a, index, "user");
    const firstBytes = (await service().historyPage("env-1", first.canvasId)).bytes;
    const second = await setup();
    await withLimit("historyBytesGlobal", firstBytes + 1024, async () => {
      for (let index = 1; index <= 6; index++)
        await moveFrame(second.canvasId, second.a, index, "user");
      // Background pruning is tracked; restarting awaits it.
      await harness.restart(serviceOptions());
      const pages = await Promise.all(
        [first.canvasId, second.canvasId].map((canvasId) =>
          service().historyPage("env-1", canvasId),
        ),
      );
      const total = pages.reduce((sum, page) => sum + page.bytes, 0);
      const atMinimum = pages.every((page) => page.total <= PROTECTED_HISTORY_ENTRIES);
      expect(total <= firstBytes + 1024 || atMinimum).toBe(true);
      expect(pages[0]!.total).toBeLessThan(8);
      for (const page of pages)
        expect(page.total).toBeGreaterThanOrEqual(PROTECTED_HISTORY_ENTRIES);
      // The newest entries stay undoable.
      await service().undo(
        second.canvasId,
        "env-1",
        (await service().get(second.canvasId, "env-1")).revision,
      );
      expect((await service().getFrame(second.canvasId, "env-1", second.a)).x).toBe(5);
    });
  });

  test("a crash after the checkpoint write but before the record rename leaves coherent history", async () => {
    const { canvasId, a } = await setup();
    await styleA(canvasId, a, "red");
    const before = await recordOf(canvasId);
    const dir = service().store.historyDir(canvasId);
    const referencedBefore = new Set(before.history.entries.map((entry) => entry.checkpoint));
    let unreferencedAtCrash: string[] = [];
    let orphan = Buffer.alloc(0);
    faults.beforeRename = (file) => {
      if (!file.endsWith(`${canvasId}.orkrec`)) return;
      delete faults.beforeRename;
      // The new checkpoint is already durable before any record references it.
      unreferencedAtCrash = readdirSync(dir).filter((name) => !referencedBefore.has(name));
      if (unreferencedAtCrash[0]) orphan = readFileSync(join(dir, unreferencedAtCrash[0]));
      throw new Error("injected crash before record rename");
    };
    await expect(styleA(canvasId, a, "blue")).rejects.toThrow("injected");
    expect(unreferencedAtCrash).toHaveLength(1);
    // The failed commit removed its own checkpoint again.
    expect(readdirSync(dir).filter((name) => !referencedBefore.has(name))).toEqual([]);
    expect(JSON.parse(orphan.toString("utf8"))).toMatchObject({ canvasId });
    const restarted = await harness.restart(serviceOptions());
    const record = await recordOf(canvasId);
    expect(record.document).toEqual(before.document);
    expect(record.history.entries.map((entry) => entry.id)).toEqual(
      before.history.entries.map((entry) => entry.id),
    );
    // Every referenced checkpoint exists and is readable.
    for (const entry of record.history.entries)
      await expect(
        restarted.checkpoint("env-1", canvasId, entry.id, "before"),
      ).resolves.toBeDefined();
    // A process that died instead of cleaning up leaves an unreferenced file;
    // collection removes it only once it is old enough not to race a writer.
    const referenced = new Set(record.history.entries.map((entry) => entry.checkpoint));
    await writeFile(join(dir, unreferencedAtCrash[0]!), orphan);
    expect((await readdir(dir)).filter((name) => !referenced.has(name))).toEqual(
      unreferencedAtCrash,
    );
    expect(await restarted.collectHistoryOrphans(canvasId)).toBe(0);
    const old = new Date(Date.now() - 60 * 60_000);
    await utimes(join(dir, unreferencedAtCrash[0]!), old, old);
    expect(await restarted.collectHistoryOrphans(canvasId)).toBe(1);
    expect((await readdir(dir)).sort()).toEqual(Array.from(referenced).sort());
    // History still works from the committed state.
    await restarted.undo(canvasId, "env-1", record.document.revision);
    expect((await restarted.getFrame(canvasId, "env-1", a)).html).not.toContain("red");
  });
});
