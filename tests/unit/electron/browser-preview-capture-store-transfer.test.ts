import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fixtureCaptureInput } from "@orkestrator/protocol/web-annotations-fixtures";
import type { WebAnnotationCaptureInput } from "@orkestrator/protocol/web-annotations";
import {
  BrowserPreviewCaptureStore,
  createBrowserPreviewCaptureId,
  MAX_EXPIRED_CAPTURE_NOTICES,
  type BrowserPreviewCaptureStoreChange,
} from "../../../apps/desktop/electron/browser-preview-capture-store";
import { pngBytes, pngDataUrl } from "./png-fixture";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function harness(limits: { perPreview?: number; perProcess?: number } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "orkestrator-capture-transfer-"));
  directories.push(root);
  const directory = path.join(root, "browser-preview-captures");
  let now = Date.parse("2026-09-24T09:00:00.000Z");
  const changes: BrowserPreviewCaptureStoreChange[] = [];
  const open = () =>
    new BrowserPreviewCaptureStore({
      directory,
      now: () => now,
      limits,
      onChange: (change) => changes.push(change),
    });
  return {
    directory,
    changes,
    open,
    store: open(),
    advance(ms: number) {
      now += ms;
    },
  };
}

/** A capture with geometry: 800×500 CSS viewport scrolled to y=120, image at 2× scale. */
function capture(): WebAnnotationCaptureInput {
  const base = fixtureCaptureInput("element");
  return {
    ...base,
    geometry: {
      viewport: { width: 800, height: 500 },
      scroll: { x: 0, y: 120 },
      zoomFactor: 1,
      devicePixelRatio: 2,
      image: { width: 1_600, height: 1_000, scale: 2, reduced: false },
    },
  };
}

function input(tabId = "browser-1", extra: Record<string, unknown> = {}) {
  return {
    captureId: createBrowserPreviewCaptureId(),
    tabId,
    environmentId: "env-fixture",
    annotationId: null,
    mode: "element" as const,
    capture: capture(),
    image: { png: pngBytes(64, 40, 1), width: 64, height: 40, reduced: false },
    ...extra,
  };
}

const ack = (captureId: string, backendCaptureId = "capture-b1") => ({
  captureId,
  annotationId: "annotation-1",
  backendCaptureId,
});

describe("manual redaction accounting", () => {
  test("region counts accumulate across passes and are clamped to the limit", async () => {
    const { store } = harness();
    const created = await store.create(input());
    await store.replaceImage(created.captureId, {
      imageDataUrl: pngDataUrl(64, 40),
      manualRegions: 2,
    });
    await store.replaceImage(created.captureId, {
      imageDataUrl: pngDataUrl(64, 40),
      manualRegions: 3,
    });
    let pending = (await store.read(created.captureId))!;
    expect(pending.capture.redaction.manualRegions).toBe(5);

    for (let pass = 0; pass < 2; pass += 1) {
      await store.replaceImage(created.captureId, {
        imageDataUrl: pngDataUrl(64, 40),
        manualRegions: 30,
      });
    }
    pending = (await store.read(created.captureId))!;
    expect(pending.capture.redaction.manualRegions).toBe(32);

    // Excluding the image adds no regions and keeps the running total.
    await store.replaceImage(created.captureId, { imageDataUrl: null, manualRegions: 0 });
    pending = (await store.read(created.captureId))!;
    expect(pending.capture.redaction).toMatchObject({ manualRegions: 32, imageExcluded: true });
  });

  test("redaction rectangles are recorded as document-space masks", async () => {
    const { store } = harness();
    const created = await store.create(
      input("browser-1", {
        masks: [{ source: "sensitive-field", rect: { x: 10, y: 130, width: 100, height: 20 } }],
      }),
    );
    // Rectangles are in pixels of the current (2× scale) image.
    await store.replaceImage(created.captureId, {
      imageDataUrl: pngDataUrl(1_600, 1_000),
      manualRegions: 0,
      regions: [{ x: 200, y: 100, width: 40, height: 60 }],
    });
    const pending = (await store.read(created.captureId))!;
    expect(pending.capture.redaction.manualRegions).toBe(1);
    expect(pending.masks).toEqual([
      { source: "sensitive-field", rect: { x: 10, y: 130, width: 100, height: 20 } },
      { source: "manual", rect: { x: 100, y: 170, width: 20, height: 30 } },
    ]);
    await expect(
      store.replaceImage(created.captureId, {
        imageDataUrl: null,
        manualRegions: 0,
        regions: [{ x: 0, y: 0, width: -1, height: 1 }],
      }),
    ).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("receipts, resume, and re-acknowledgement", () => {
  test("a recorded receipt survives a restart so the renderer re-acks instead of recommitting", async () => {
    const spool = harness();
    const created = await spool.store.create(input());
    expect(created.receipt).toBeNull();
    const recorded = await spool.store.recordReceipt(ack(created.captureId));
    expect(recorded?.receipt).toEqual({
      annotationId: "annotation-1",
      backendCaptureId: "capture-b1",
    });
    expect(recorded?.acknowledged).toBe(false);
    // Idempotent.
    await spool.store.recordReceipt(ack(created.captureId));
    expect(spool.changes.filter((change) => change.reason === "receipt")).toHaveLength(2);

    const restarted = spool.open();
    const [listed] = await restarted.list();
    expect(listed).toMatchObject({
      captureId: created.captureId,
      acknowledged: false,
      receipt: { annotationId: "annotation-1", backendCaptureId: "capture-b1" },
    });
    await restarted.acknowledge(ack(created.captureId));
    expect(await restarted.list()).toEqual([]);
    // A duplicate ack after clearing is harmless; an unknown receipt is null.
    await restarted.acknowledge(ack(created.captureId));
    expect(await restarted.recordReceipt(ack(created.captureId))).toBeNull();
  });

  test("acknowledging remembers mask geometry for a later result capture", async () => {
    const { store, open } = harness();
    const masks = [{ source: "manual" as const, rect: { x: 1, y: 2, width: 3, height: 4 } }];
    const created = await store.create(input("browser-1", { masks }));
    await store.acknowledge(ack(created.captureId, "capture-original"));
    expect(await store.masksFor("capture-original")).toEqual(masks);
    expect(await open().masksFor("capture-original")).toEqual(masks);
    expect(await store.masksFor("capture-unknown")).toBeNull();
  });
});

describe("recapture replaces a pending capture", () => {
  test("the replaced record is excluded from capacity and removed once the new one is written", async () => {
    const spool = harness({ perPreview: 1 });
    const stale = await spool.store.create(input());
    expect(await spool.store.hasCapacity("browser-1")).toBe(false);
    expect(await spool.store.hasCapacity("browser-1", { excluding: stale.captureId })).toBe(true);
    const fresh = await spool.store.create(input("browser-1", { replaces: stale.captureId }));
    expect(fresh.recaptureOf).toBe(stale.captureId);
    expect((await spool.store.list()).map((entry) => entry.captureId)).toEqual([fresh.captureId]);
    expect(readdirSync(spool.directory).filter((file) => file.startsWith(stale.captureId))).toEqual(
      [],
    );
    expect(spool.changes.slice(-2).map((change) => change.reason)).toEqual([
      "created",
      "discarded",
    ]);
  });

  test("capacity for a set of several captures is checked up front", async () => {
    const { store } = harness({ perPreview: 4 });
    await store.create(input());
    expect(await store.hasCapacity("browser-1", { count: 3 })).toBe(true);
    expect(await store.hasCapacity("browser-1", { count: 4 })).toBe(false);
  });
});

describe("image write failure", () => {
  test("a failed image write leaves no record, no partial files, and a working spool", async () => {
    const spool = harness();
    await spool.store.ready;
    const failing = input();
    // Occupy the image path with a non-empty directory so the atomic rename fails.
    const blocked = path.join(spool.directory, `${failing.captureId}-1.png`);
    mkdirSync(blocked);
    writeFileSync(path.join(blocked, "occupied"), "x");

    await expect(spool.store.create(failing)).rejects.toThrow();
    expect(await spool.store.list()).toEqual([]);
    expect(
      readdirSync(spool.directory).filter(
        (file) => file.endsWith(".tmp") || file === `${failing.captureId}.json`,
      ),
    ).toEqual([]);
    expect(spool.changes.some((change) => change.captureId === failing.captureId)).toBe(false);

    const next = await spool.store.create(input());
    expect((await spool.store.list()).map((entry) => entry.captureId)).toEqual([next.captureId]);
    expect(await spool.open().list()).toHaveLength(1);
  });
});

describe("expired-capture notices", () => {
  test("notices are bounded, newest first, dismissible, and persisted", async () => {
    const spool = harness({ perProcess: 64, perPreview: 64 });
    const ids: string[] = [];
    for (let index = 0; index < MAX_EXPIRED_CAPTURE_NOTICES + 3; index += 1) {
      ids.push((await spool.store.create(input(`tab-${index}`))).captureId);
      spool.advance(1_000);
    }
    spool.advance(24 * 60 * 60 * 1000);
    await spool.store.sweepExpired();
    const notices = await spool.store.listExpiredNotices();
    expect(notices).toHaveLength(MAX_EXPIRED_CAPTURE_NOTICES);
    expect(notices[0]!.captureId).toBe(ids.at(-1));
    expect(JSON.stringify(notices)).not.toContain("Save");

    await spool.store.dismissExpiredNotices([ids.at(-1)!]);
    expect(await spool.open().listExpiredNotices()).toHaveLength(MAX_EXPIRED_CAPTURE_NOTICES - 1);
    await spool.store.dismissExpiredNotices();
    expect(await spool.open().listExpiredNotices()).toEqual([]);
    await expect(spool.store.dismissExpiredNotices(["not-a-capture"])).rejects.toMatchObject({
      code: "invalid",
    });
  });
});
