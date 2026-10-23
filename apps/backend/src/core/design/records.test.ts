import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DESIGN_MAX_DOCUMENT_BYTES, type DesignCanvas } from "@orkestrator/protocol/design-canvas";
import { isDesignError } from "./errors.js";
import {
  DESIGN_LIMITS,
  type DesignOperationDescriptor,
  type DesignOperationStatus,
} from "@orkestrator/protocol/design-operations";
import {
  addReceipt,
  cloneRecord,
  DesignRecordStore,
  intentDigest,
  migrateLegacy,
  newRecord,
  portableBytes,
  receiptDigest,
  RECORD_KIND,
  type DesignPrivateRecord,
} from "./records.js";
import { canvasSchema } from "./schemas.js";
import {
  createDesignHarness,
  trackUnhandledRejections,
  withDesignLimit,
  type DesignHarness,
} from "./test-support.js";

function legacyCanvas(environmentId = "env-1"): DesignCanvas {
  return {
    format: "orkdes",
    version: 1,
    id: crypto.randomUUID(),
    environmentId,
    name: "Legacy design",
    revision: 5,
    frames: [
      {
        id: crypto.randomUUID(),
        name: "Old",
        x: 10,
        y: 20,
        width: 300,
        height: 200,
        html: "<h1>Old</h1>",
        revision: 3,
      },
    ],
  };
}

describe("design private records, legacy migration and recovery states", () => {
  let harness: DesignHarness;
  const rejections = trackUnhandledRejections();
  const service = () => harness.service;
  const root = () => join(harness.dir, "design-canvases");

  beforeEach(async () => {
    rejections.install();
    harness = await createDesignHarness({ prefix: "ork-design-records-" });
    await mkdir(join(harness.dir, "design-canvases"), { recursive: true });
  });
  afterEach(async () => {
    await harness.close();
    rejections.remove();
    expect(rejections.seen).toEqual([]);
    rejections.seen.length = 0;
  });

  const writeLegacy = async (canvas: DesignCanvas) => {
    const bytes = JSON.stringify(canvas, null, 2);
    await writeFile(join(root(), `${canvas.id}.orkdes`), bytes);
    return bytes;
  };
  const files = async () => (await readdir(root(), { recursive: true })).map(String).sort();
  const failureOf = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: unknown) => error,
    );

  test("legacy documents are read in place and migrated lazily on the first mutation", async () => {
    const canvas = legacyCanvas();
    const original = await writeLegacy(canvas);
    const frameId = canvas.frames[0]!.id;
    expect(await service().get(canvas.id, "env-1")).toEqual(canvas);
    expect(await service().list("env-1")).toEqual([
      { id: canvas.id, name: "Legacy design", revision: 5 },
    ]);
    const first = await service().snapshot("env-1", canvas.id);
    expect(first).toMatchObject({ kind: "snapshot", workspace: { migratedFromLegacy: true } });
    // Reading (including the lazy validation it schedules) never migrates, and
    // the synthesized metadata is deterministic. Restart awaits background work.
    const restarted = await harness.restart();
    expect(harness.renderer.jobs).toContainEqual(
      expect.objectContaining({ canvasId: canvas.id, op: "validate" }),
    );
    expect((await files()).filter((file) => file.endsWith(".orkrec"))).toEqual([]);
    const again = await restarted.snapshot("env-1", canvas.id);
    if (first.kind !== "snapshot" || again.kind !== "snapshot")
      throw new Error("expected snapshots");
    expect(again.workspace.incarnation).toBe(first.workspace.incarnation);
    expect(again.workspace.frames).toEqual(first.workspace.frames);
    // The first mutation migrates, preserving identities and revisions.
    const moved = await restarted.mutate(canvas.id, "env-1", frameId, 3, { x: 99 }, "user");
    expect(moved).toMatchObject({ canvasRevision: 6, frame: { id: frameId, revision: 4, x: 99 } });
    const record = JSON.parse(
      await readFile(restarted.store.recordFile(canvas.id), "utf8"),
    ) as DesignPrivateRecord;
    expect(record).toMatchObject({
      kind: RECORD_KIND,
      canvasId: canvas.id,
      migratedFromLegacy: true,
    });
    expect(record.document.frames.map((frame) => frame.id)).toEqual([frameId]);
    expect(record.history.entries.map((entry) => [entry.kind, entry.actor])).toEqual([
      ["update_frame", "user"],
    ]);
    expect(await files()).not.toContain(`${canvas.id}.orkdes`);
    expect(await readFile(restarted.store.legacyBackupFile(canvas.id), "utf8")).toBe(original);
    // The migrated edit is undoable and history survives restart.
    const afterRestart = await harness.restart();
    await afterRestart.undo(canvas.id, "env-1", 6);
    expect(await afterRestart.getFrame(canvas.id, "env-1", frameId)).toMatchObject({
      x: 10,
      revision: 5,
    });
  });

  test("restart reports a never-migrated canvas's admitted edits as interrupted without migrating it", async () => {
    const canvas = legacyCanvas();
    await writeLegacy(canvas);
    const frameId = canvas.frames[0]!.id;
    const move = (x: number, correlationId: string): DesignOperationDescriptor => ({
      canvasId: canvas.id,
      input: { kind: "update_frame", frameId, patch: { x } },
      preconditions: { frameRevision: 3 },
      correlationId,
    });
    const lost = await service().prepare("env-1", "user", move(40, "lost"));
    const records = async () => (await files()).filter((file) => file.endsWith(".orkrec"));
    let restarted = await harness.restart();
    const interrupted = await restarted.status("env-1", canvas.id, lost.token);
    expect(interrupted).toMatchObject({
      state: "interrupted",
      correlationId: "lost",
      failure: { code: "unknown-outcome" },
    });
    // Executing, canceling and retrying it answer the same and never run it.
    expect(await restarted.execute("env-1", canvas.id, lost.token)).toMatchObject({
      state: "interrupted",
    });
    expect(await restarted.cancel("env-1", canvas.id, lost.token)).toMatchObject({
      state: "interrupted",
    });
    await expect(restarted.prepare("env-1", "user", move(40, "lost"))).rejects.toThrow(
      "already has a settled operation",
    );
    await expect(restarted.prepare("env-1", "user", move(41, "lost"))).rejects.toThrow(
      "already used for a different edit",
    );
    // submit_operation replays it for the same edit only.
    expect(await restarted.settledCorrelation("env-1", canvas.id, move(40, "lost"))).toMatchObject({
      status: { token: lost.token, state: "interrupted" },
      matches: true,
    });
    expect(await restarted.settledCorrelation("env-1", canvas.id, move(41, "lost"))).toMatchObject({
      matches: false,
    });
    expect(harness.renderer.jobs.filter((job) => job.op !== "validate")).toEqual([]);
    expect((await restarted.get(canvas.id, "env-1")).frames[0]!.x).toBe(10);
    // Recovery, status and these answers did not migrate the canvas.
    expect(await records()).toEqual([]);
    // Another restart keeps the outcome, and the first real edit migrates the
    // canvas with it as a receipt.
    restarted = await harness.restart();
    const edit = await restarted.prepare("env-1", "user", move(70, "edit"));
    expect(await restarted.execute("env-1", canvas.id, edit.token)).toMatchObject({
      state: "committed",
    });
    expect(await records()).toEqual([`${canvas.id}.orkrec`]);
    const record = JSON.parse(
      await readFile(restarted.store.recordFile(canvas.id), "utf8"),
    ) as DesignPrivateRecord;
    expect(record.receipts.map((receipt) => [receipt.token, receipt.state])).toEqual([
      [edit.token, "committed"],
      [lost.token, "interrupted"],
    ]);
    expect(receiptDigest(record, lost.token)).toBe(intentDigest(move(40, "lost")));
    restarted = await harness.restart();
    expect(await restarted.status("env-1", canvas.id, lost.token)).toMatchObject({
      state: "interrupted",
    });
    // Its receipt settles it; recovery compacts the entry away.
    expect(await restarted.store.readPending(canvas.id)).toEqual([]);
  });

  test("a never-migrated canvas keeps restart outcomes within the pending bounds", async () => {
    const canvas = legacyCanvas();
    await writeLegacy(canvas);
    const frameId = canvas.frames[0]!.id;
    const move = (x: number): DesignOperationDescriptor => ({
      canvasId: canvas.id,
      input: { kind: "update_frame", frameId, patch: { x } },
      preconditions: { frameRevision: 3 },
    });
    await withDesignLimit("preparedPerCanvas", 2, async () => {
      const first = await service().prepare("env-1", "user", move(1));
      const second = await service().prepare("env-1", "user", move(2));
      const restarted = await harness.restart();
      // Kept outcomes never block new edits: the oldest gives way.
      const next = await restarted.prepare("env-1", "user", move(3));
      expect((await restarted.store.readPending(canvas.id)).map((entry) => entry.token)).toEqual([
        second.token,
        next.token,
      ]);
      expect((await restarted.status("env-1", canvas.id, first.token)).state).toBe("unknown");
      expect((await restarted.status("env-1", canvas.id, second.token)).state).toBe("interrupted");
      expect((await restarted.status("env-1", canvas.id, next.token)).state).toBe("prepared");
    });
  });

  test("deleting the environment also removes a migrated canvas's legacy backup", async () => {
    const canvas = legacyCanvas();
    await writeLegacy(canvas);
    await service().mutate(canvas.id, "env-1", canvas.frames[0]!.id, 3, { x: 1 }, "user");
    expect(await readdir(join(root(), "legacy-backups"))).toContain(`${canvas.id}.orkdes`);

    expect(await service().deleteEnvironment("env-1")).toBe(1);
    expect(await readdir(join(root(), "legacy-backups"))).not.toContain(`${canvas.id}.orkdes`);
  });

  test("an interrupted migration (record written, legacy not retired) reads the record", async () => {
    const canvas = legacyCanvas();
    await writeLegacy(canvas);
    await service().mutate(
      canvas.id,
      "env-1",
      canvas.frames[0]!.id,
      3,
      { name: "Migrated" },
      "user",
    );
    await service().close();
    // Simulate a crash between the record commit and retiring the legacy file.
    await writeLegacy(canvas);
    const restarted = await harness.restart();
    const current = await restarted.get(canvas.id, "env-1");
    expect(current.revision).toBe(6);
    expect(current.frames[0]!.name).toBe("Migrated");
    expect(await restarted.list("env-1")).toEqual([
      { id: canvas.id, name: "Legacy design", revision: 6 },
    ]);
    await restarted.mutate(canvas.id, "env-1", canvas.frames[0]!.id, 4, { x: 1 }, "user");
    expect((await restarted.get(canvas.id, "env-1")).revision).toBe(7);
    // Startup finished the interrupted migration: the stale legacy copy is retired.
    const files = await readdir(root());
    expect(files).not.toContain(`${canvas.id}.orkdes`);
    expect(await readdir(join(root(), "legacy-backups"))).toContain(`${canvas.id}.orkdes`);
  });

  test("a corrupt record with a legacy copy present is a recovery state, never the legacy copy", async () => {
    const canvas = legacyCanvas();
    const legacy = await writeLegacy(canvas);
    await writeFile(join(root(), `${canvas.id}.orkrec`), "{corrupt");
    expect(await service().snapshot("env-1", canvas.id)).toMatchObject({
      kind: "record-problem",
      problem: "corrupt",
      backupAvailable: true,
      canvasId: canvas.id,
    });
    // The owner is recovered from the legacy copy; other environments see nothing.
    expect(await service().snapshot("env-2", canvas.id)).toMatchObject({ kind: "missing" });
    expect(isDesignError(await failureOf(service().get(canvas.id, "env-1")), "storage")).toBe(true);
    const edit = await failureOf(
      service().mutate(canvas.id, "env-1", canvas.frames[0]!.id, 3, { x: 1 }, "user"),
    );
    expect(isDesignError(edit, "storage")).toBe(true);
    expect(await service().list("env-1")).toEqual([]);
    expect((await service().libraryPage("env-1", { filter: "all" })).entries).toMatchObject([
      { id: canvas.id, state: "problem", problem: "corrupt" },
    ]);
    expect(await readFile(join(root(), `${canvas.id}.orkrec`), "utf8")).toBe("{corrupt");
    expect(await readFile(join(root(), `${canvas.id}.orkdes`), "utf8")).toBe(legacy);
  });

  test("an unsupported future record version is reported and never overwritten", async () => {
    const record = cloneRecord(
      newRecord(crypto.randomUUID(), "env-1", new Date(0).toISOString(), "live"),
    );
    const future = JSON.stringify({
      ...record,
      recordVersion: 99,
      futureField: { anything: true },
    });
    const file = join(root(), `${record.canvasId}.orkrec`);
    await writeFile(file, future);
    expect(await service().snapshot("env-1", record.canvasId)).toMatchObject({
      kind: "record-problem",
      problem: "unsupported-version",
      backupAvailable: false,
    });
    await expect(service().delete(record.canvasId, "env-1", "user")).rejects.toThrow(
      "newer Orkestrator",
    );
    await expect(
      service().createFrame(record.canvasId, "env-1", 0, {
        name: "x",
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        html: "<p>x</p>",
      }),
    ).rejects.toThrow("newer Orkestrator");
    const restarted = await harness.restart();
    expect(await restarted.snapshot("env-1", record.canvasId)).toMatchObject({
      problem: "unsupported-version",
    });
    expect(await readFile(file, "utf8")).toBe(future);
  });

  test("portable exports are strict v1 documents without private fields", async () => {
    const canvas = await service().create("env-1", "Portable", undefined, "user");
    const { frame } = await service().createFrame(
      canvas.id,
      "env-1",
      1,
      { name: "Only", x: 0, y: 0, width: 200, height: 100, html: "<p>x</p>" },
      "user",
    );
    await service().linkSession("env-1", canvas.id, {
      tabId: "tab",
      sessionId: "secret-session",
      platform: "claude",
      role: "design",
    });
    const exported = await service().get(canvas.id, "env-1");
    expect(Object.keys(exported).sort()).toEqual([
      "environmentId",
      "format",
      "frames",
      "id",
      "name",
      "revision",
      "version",
    ]);
    expect(Object.keys(exported.frames[0]!).sort()).toEqual([
      "height",
      "html",
      "id",
      "name",
      "revision",
      "width",
      "x",
      "y",
    ]);
    const loaded = await service().load(canvas.id);
    if (loaded.kind !== "record") throw new Error(loaded.kind);
    const tainted = cloneRecord(loaded.record);
    Object.assign(tainted.document, { receipts: ["op_x"], sessions: ["secret"] });
    Object.assign(tainted.document.frames[0]!, {
      contentId: "c.1",
      validation: { state: "valid" },
    });
    const text = portableBytes(tainted.document).toString("utf8");
    for (const secret of [
      "receipts",
      "sessions",
      "secret",
      "contentId",
      "validation",
      "op_",
      "incarnation",
    ])
      expect(text).not.toContain(secret);
    expect(canvasSchema.parse(JSON.parse(text))).toMatchObject({
      id: canvas.id,
      frames: [{ id: frame.id }],
    });
    // Re-importing the export creates fresh identities without any workspace metadata.
    const imported = await service().create("env-2", "unused", text, "user");
    const snapshot = await service().snapshot("env-2", imported.id);
    expect(snapshot).toMatchObject({ kind: "snapshot", workspace: { sessions: [] } });
    expect(JSON.stringify(snapshot)).not.toContain("secret-session");
  });

  test("the record byte limit rejects before replacing the previous record", async () => {
    const store = new DesignRecordStore(harness.dir);
    const record = newRecord(crypto.randomUUID(), "env-1", new Date(0).toISOString(), "live");
    await store.write(record);
    const before = await readFile(store.recordFile(record.canvasId));
    const huge = cloneRecord(record);
    huge.document.frames = Array.from({ length: 30 }, (_, index) => ({
      id: crypto.randomUUID(),
      name: `Huge ${index}`,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      html: "x".repeat(250 * 1024),
      revision: 1,
    }));
    const error = await failureOf(store.write(huge));
    expect(isDesignError(error, "capacity")).toBe(true);
    expect(await readFile(store.recordFile(record.canvasId))).toEqual(before);
    expect((await files()).filter((file) => file.endsWith(".tmp"))).toEqual([]);
  });

  test("a commit that would exceed the 4 MiB portable document limit is rejected and nothing changes", async () => {
    const canvas = await service().create("env-1", "Large", undefined, "user");
    const html = `<p>${"x".repeat(250 * 1024)}</p>`;
    let revision = 1;
    const frame = (index: number) => ({
      name: `Big ${index}`,
      x: index,
      y: 0,
      width: 100,
      height: 100,
      html,
    });
    while (revision < 64) {
      const attempt = await failureOf(
        service().createFrame(canvas.id, "env-1", revision, frame(revision), "user"),
      );
      if (attempt) {
        expect(isDesignError(attempt, "invalid-content")).toBe(true);
        expect((attempt as Error).message).toContain("4 MiB");
        break;
      }
      revision++;
    }
    const current = await service().get(canvas.id, "env-1");
    expect(current.revision).toBe(revision);
    expect(portableBytes(current).byteLength).toBeLessThanOrEqual(DESIGN_MAX_DOCUMENT_BYTES);
    expect(portableBytes(current).byteLength + Buffer.byteLength(html)).toBeGreaterThan(
      DESIGN_MAX_DOCUMENT_BYTES,
    );
    // The last committed revision still re-imports as a portable file.
    await expect(
      service().create("env-2", "Copy", portableBytes(current).toString("utf8"), "user"),
    ).resolves.toBeDefined();
  }, 30_000);

  test("receipt digests are kept only for correlated receipts and pruned with them", () => {
    const record = newRecord(crypto.randomUUID(), "env-1", new Date(0).toISOString(), "live");
    const receipt = (token: string, extra: Partial<DesignOperationStatus> = {}) =>
      ({
        token,
        canvasId: record.canvasId,
        kind: "update_frame",
        state: "committed",
        actor: "agent",
        base: {},
        correlationId: `corr-${token}`,
        preparedAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        ...extra,
      }) satisfies DesignOperationStatus;
    const descriptor = (n: number): DesignOperationDescriptor => ({
      canvasId: record.canvasId,
      input: { kind: "update_frame", frameId: record.canvasId, patch: { x: n } },
      preconditions: {},
      correlationId: `corr-op_${n}`,
    });
    addReceipt(record, receipt("op_0", { correlationId: undefined }), descriptor(0));
    expect(record.receiptDigests).toBeUndefined();
    for (let n = 1; n <= DESIGN_LIMITS.receiptsPerCanvas + 1; n++)
      addReceipt(record, receipt(`op_${n}`), descriptor(n));
    // The count bound drops the oldest receipts and their digests together.
    expect(record.receipts).toHaveLength(DESIGN_LIMITS.receiptsPerCanvas);
    expect(record.receipts[0]!.token).toBe("op_2");
    expect(Object.keys(record.receiptDigests!).sort()).toEqual(
      record.receipts.map((entry) => entry.token).sort(),
    );
    expect(receiptDigest(record, "op_1")).toBeUndefined();
    expect(receiptDigest(record, "op_2")).toBe(intentDigest(descriptor(2)));
    // Digests count toward the receipt byte budget.
    const failure = { code: "conflict", message: "x".repeat(900), retry: "never" } as const;
    for (let n = 0; n < DESIGN_LIMITS.receiptsPerCanvas; n++)
      addReceipt(record, receipt(`op_bulky_${n}`, { failure }), descriptor(n));
    const receiptBytes = Buffer.byteLength(JSON.stringify(record.receipts));
    const digestBytes = Buffer.byteLength(JSON.stringify(record.receiptDigests));
    expect(receiptBytes + digestBytes).toBeLessThanOrEqual(DESIGN_LIMITS.receiptBytesPerCanvas);
    expect(receiptBytes + digestBytes).toBeGreaterThan(DESIGN_LIMITS.receiptBytesPerCanvas - 1_200);
    expect(Object.keys(record.receiptDigests!)).toHaveLength(record.receipts.length);
  });

  test("the intent digest ignores key order but not values or style order", () => {
    const frameId = "00000000-0000-4000-8000-000000000001";
    const kind = "set_element_styles";
    const styled = (styles: Record<string, string | null>): DesignOperationDescriptor => ({
      correlationId: "c",
      preconditions: { frameRevision: 1 },
      canvasId: "00000000-0000-4000-8000-000000000000",
      input: { kind, frameId, selector: "h1", styles },
    });
    const styles = { margin: "0", "margin-top": "10px" };
    const base = styled(styles);
    // Descriptor and input keys may arrive in any order.
    expect(
      intentDigest({
        input: { styles, selector: "h1", frameId, kind },
        canvasId: base.canvasId,
        preconditions: { frameRevision: 1 },
        correlationId: "c",
      }),
    ).toBe(intentDigest(base));
    expect(intentDigest(base)).not.toBe(intentDigest(styled({ ...styles, "margin-top": "9px" })));
    // Styles apply in order: a shorthand after its longhand resets it.
    const reversed = { "margin-top": "10px", margin: "0" };
    expect(intentDigest(base)).not.toBe(intentDigest(styled(reversed)));
    const batch = (styles: Record<string, string | null>): DesignOperationDescriptor => ({
      ...base,
      input: {
        kind: "batch",
        operations: [
          { kind: "update_frame", frameId, patch: { x: 1, y: 2 } },
          { kind, frameId, selector: "h1", styles },
        ],
      },
    });
    const batchReordered: DesignOperationDescriptor = {
      ...base,
      input: {
        operations: [
          { patch: { y: 2, x: 1 }, frameId, kind: "update_frame" },
          { styles, selector: "h1", frameId, kind },
        ],
        kind: "batch",
      },
    };
    expect(intentDigest(batch(styles))).toBe(intentDigest(batchReordered));
    expect(intentDigest(batch(styles))).not.toBe(intentDigest(batch(reversed)));
  });

  test("legacy migration metadata is deterministic for the same snapshot", () => {
    const canvas = legacyCanvas();
    const at = new Date("2026-01-01T00:00:00.000Z");
    expect(migrateLegacy(canvas, at)).toEqual(migrateLegacy(canvas, at));
  });
});
