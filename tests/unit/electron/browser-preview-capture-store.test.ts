import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fixtureCaptureInput } from "@orkestrator/protocol/web-annotations-fixtures";
import {
  BrowserPreviewCaptureStore,
  createBrowserPreviewCaptureId,
  type BrowserPreviewCaptureStoreChange,
  type BrowserPreviewCaptureStoreOptions,
} from "../../../apps/desktop/electron/browser-preview-capture-store";
import { pngBytes, pngDataUrl } from "./png-fixture";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function spoolDirectory(): string {
  const root = mkdtempSync(path.join(tmpdir(), "orkestrator-capture-spool-"));
  directories.push(root);
  return path.join(root, "browser-preview-captures");
}

function harness(options: Partial<BrowserPreviewCaptureStoreOptions> = {}) {
  let now = Date.parse("2026-09-24T09:00:00.000Z");
  const changes: BrowserPreviewCaptureStoreChange[] = [];
  const directory = options.directory ?? spoolDirectory();
  const open = () =>
    new BrowserPreviewCaptureStore({
      directory,
      now: () => now,
      onChange: (change) => changes.push(change),
      ...options,
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

function createInput(
  tabId = "browser-1",
  options: { image?: Buffer | null; captureId?: string; stale?: string } = {},
) {
  const image = options.image === undefined ? pngBytes(64, 40, 1) : options.image;
  const capture = fixtureCaptureInput("element");
  return {
    captureId: options.captureId ?? createBrowserPreviewCaptureId(),
    tabId,
    environmentId: "env-fixture",
    annotationId: null,
    mode: "element" as const,
    capture: options.stale ? { ...capture, stale: { reason: options.stale } } : capture,
    image: image ? { png: image, width: 64, height: 40, reduced: true } : null,
  };
}

function files(directory: string): string[] {
  return readdirSync(directory).sort();
}

function allBytes(directory: string): Buffer {
  return Buffer.concat(files(directory).map((file) => readFileSync(path.join(directory, file))));
}

describe("browser preview capture spool", () => {
  test("writes private files atomically and reading never consumes the record", async () => {
    const { store, directory } = harness();
    const first = await store.create(createInput());
    const second = await store.create(createInput("browser-2", { stale: "The page navigated." }));

    expect(statSync(directory).mode & 0o777).toBe(0o700);
    for (const file of files(directory)) {
      expect(statSync(path.join(directory, file)).mode & 0o777).toBe(0o600);
      expect(file.endsWith(".tmp")).toBe(false);
    }
    expect(files(directory)).toEqual(
      [
        `${first.captureId}-1.png`,
        `${first.captureId}.json`,
        `${second.captureId}-1.png`,
        `${second.captureId}.json`,
      ].sort(),
    );
    expect(first).toMatchObject({
      tabId: "browser-1",
      environmentId: "env-fixture",
      mode: "element",
      createdAt: "2026-09-24T09:00:00.000Z",
      expiresAt: "2026-09-25T09:00:00.000Z",
      targetLabel: "button “Save”",
      pageTitle: "Settings",
      stale: false,
      staleReason: null,
      image: { width: 64, height: 40, bytes: pngBytes(64, 40, 1).length, reduced: true },
      acknowledged: false,
    });
    expect(second).toMatchObject({ stale: true, staleReason: "The page navigated." });

    const listed = await store.list();
    expect(listed.map((entry) => entry.captureId)).toEqual([second.captureId, first.captureId]);
    const read = await store.read(first.captureId);
    const again = await store.read(first.captureId);
    expect(read?.imageDataUrl).toBe(pngDataUrl(64, 40, 1));
    expect(read?.capture.page.route).toBe("/settings?tab=profile");
    expect(again?.descriptor.captureId).toBe(first.captureId);
    expect(await store.read("capture-not-a-real-id")).toBeNull();
  });

  test("recovers pending captures after a restart", async () => {
    const first = harness();
    const created = await first.store.create(createInput());
    const restarted = first.open();

    expect((await restarted.list()).map((entry) => entry.captureId)).toEqual([created.captureId]);
    expect((await restarted.read(created.captureId))?.imageDataUrl).toBe(pngDataUrl(64, 40, 1));
    const next = await restarted.create(createInput());
    expect((await restarted.list())[0]?.captureId).toBe(next.captureId);
  });

  test("drops malformed records, orphan images, and temporary files on load", async () => {
    const first = harness();
    const valid = await first.store.create(createInput());
    const truncated = await first.store.create(createInput());
    const invalidCapture = createBrowserPreviewCaptureId();
    const garbage = createBrowserPreviewCaptureId();
    const orphan = createBrowserPreviewCaptureId();
    const directory = first.directory;
    writeFileSync(path.join(directory, `${garbage}.json`), "{not json");
    const record = JSON.parse(
      readFileSync(path.join(directory, `${valid.captureId}.json`), "utf8"),
    );
    writeFileSync(
      path.join(directory, `${invalidCapture}.json`),
      JSON.stringify({
        ...record,
        imageFile: null,
        descriptor: { ...record.descriptor, captureId: invalidCapture, image: null },
        capture: { ...record.capture, producer: "page-said-so" },
      }),
    );
    writeFileSync(path.join(directory, `${orphan}-1.png`), pngBytes(4, 4));
    writeFileSync(path.join(directory, `${valid.captureId}.json.abc123.tmp`), "partial");
    writeFileSync(path.join(directory, `${truncated.captureId}-1.png`), pngBytes(8, 8));
    writeFileSync(path.join(directory, "unrelated.txt"), "left alone");

    const restarted = first.open();
    expect((await restarted.list()).map((entry) => entry.captureId)).toEqual([valid.captureId]);
    expect(files(directory)).toEqual(
      [`${valid.captureId}-1.png`, `${valid.captureId}.json`, "unrelated.txt"].sort(),
    );
  });

  test("expires records after 24 hours with an injected clock and a content-free notice", async () => {
    const spool = harness();
    const created = await spool.store.create(createInput());
    spool.advance(24 * 60 * 60 * 1000 - 1);
    expect(await spool.store.list()).toHaveLength(1);

    spool.advance(1);
    expect(await spool.store.sweepExpired()).toBe(1);
    expect(await spool.store.list()).toEqual([]);
    // Only the content-free notice list remains; the capture files are gone.
    expect(files(spool.directory)).toEqual(["expired-notices.json"]);
    const notice = {
      captureId: created.captureId,
      tabId: "browser-1",
      environmentId: "env-fixture",
      annotationId: null,
      mode: "element",
      displayUrl: created.displayUrl,
      createdAt: created.createdAt,
      expiredAt: created.expiresAt,
      whileClosed: false,
    };
    expect(spool.changes.at(-1)).toEqual({
      captureId: created.captureId,
      tabId: "browser-1",
      reason: "expired",
      notice,
    });
    expect(await spool.store.listExpiredNotices()).toEqual([notice]);
  });

  test("an expired record is removed on startup and leaves an expired-while-closed notice", async () => {
    const spool = harness();
    const created = await spool.store.create(createInput());
    spool.advance(25 * 60 * 60 * 1000);
    const restarted = spool.open();
    expect(await restarted.list()).toEqual([]);
    expect(files(spool.directory)).toEqual(["expired-notices.json"]);
    expect(await restarted.listExpiredNotices()).toEqual([
      expect.objectContaining({ captureId: created.captureId, whileClosed: true }),
    ]);
    expect(spool.changes.at(-1)).toMatchObject({ reason: "expired", captureId: created.captureId });
  });

  test("rejects captures beyond per-preview, per-process, and byte capacity without eviction", async () => {
    const perPreview = harness();
    for (let index = 0; index < 4; index += 1)
      await perPreview.store.create(createInput("browser-1"));
    expect(await perPreview.store.hasCapacity("browser-1")).toBe(false);
    expect(await perPreview.store.hasCapacity("browser-2")).toBe(true);
    await expect(perPreview.store.create(createInput("browser-1"))).rejects.toMatchObject({
      code: "spool-full",
    });
    expect(await perPreview.store.list()).toHaveLength(4);

    const perProcess = harness({ limits: { perProcess: 3 } });
    for (let index = 0; index < 3; index += 1)
      await perProcess.store.create(createInput(`tab-${index}`));
    await expect(perProcess.store.create(createInput("tab-new"))).rejects.toMatchObject({
      code: "spool-full",
    });
    expect(await perProcess.store.list()).toHaveLength(3);

    const bytes = pngBytes(64, 40, 1).length;
    const perBytes = harness({ limits: { imageBytes: bytes * 2 } });
    await perBytes.store.create(createInput("tab-a"));
    await perBytes.store.create(createInput("tab-b"));
    await expect(perBytes.store.create(createInput("tab-c"))).rejects.toMatchObject({
      code: "spool-full",
    });
    await perBytes.store.create(createInput("tab-c", { image: null }));
    expect(await perBytes.store.list()).toHaveLength(3);
  });

  test("acknowledgement clears the record; duplicate and unknown acks are harmless", async () => {
    const spool = harness();
    const created = await spool.store.create(createInput());
    const ack = {
      captureId: created.captureId,
      annotationId: "annotation-1",
      backendCaptureId: "capture-backend-1",
    };

    await spool.store.acknowledge(ack);
    await spool.store.acknowledge(ack);
    await spool.store.acknowledge({ ...ack, captureId: createBrowserPreviewCaptureId() });

    expect(await spool.store.list()).toEqual([]);
    expect(files(spool.directory)).toEqual([]);
    expect(spool.changes.filter((change) => change.reason === "acknowledged")).toHaveLength(1);
    await expect(spool.store.acknowledge({ ...ack, annotationId: "../escape" })).rejects.toThrow(
      "Invalid capture acknowledgement",
    );
  });

  test("discard removes only the named capture and tolerates unknown ids", async () => {
    const spool = harness();
    const keep = await spool.store.create(createInput());
    const drop = await spool.store.create(createInput());
    await spool.store.discard(drop.captureId);
    await spool.store.discard(drop.captureId);
    expect((await spool.store.list()).map((entry) => entry.captureId)).toEqual([keep.captureId]);
    await expect(spool.store.discard("not-a-capture")).rejects.toThrow("Invalid capture id");
  });

  test("replacing the image drops the unredacted bytes from disk", async () => {
    const spool = harness();
    const original = pngBytes(64, 40, 0xab);
    const created = await spool.store.create(createInput("browser-1", { image: original }));
    const originalPixels = readFileSync(path.join(spool.directory, `${created.captureId}-1.png`));
    expect(originalPixels.equals(original)).toBe(true);

    const redacted = await spool.store.replaceImage(created.captureId, {
      imageDataUrl: pngDataUrl(64, 40, 0x11),
      manualRegions: 2,
    });

    expect(files(spool.directory)).toEqual([
      `${created.captureId}-2.png`,
      `${created.captureId}.json`,
    ]);
    expect(allBytes(spool.directory).includes(original)).toBe(false);
    expect(redacted.image).toMatchObject({
      width: 64,
      height: 40,
      bytes: pngBytes(64, 40, 0x11).length,
    });
    const read = await spool.store.read(created.captureId);
    expect(read?.imageDataUrl).toBe(pngDataUrl(64, 40, 0x11));
    expect(read?.capture.redaction).toMatchObject({ manualRegions: 2, imageExcluded: false });
    expect(read?.capture.geometry?.image).toMatchObject({
      width: 64,
      height: 40,
      scale: 64 / 1280,
    });

    const excluded = await spool.store.replaceImage(created.captureId, {
      imageDataUrl: null,
      manualRegions: 0,
    });
    expect(excluded.image).toBeNull();
    expect(files(spool.directory)).toEqual([`${created.captureId}.json`]);
    const final = await spool.store.read(created.captureId);
    expect(final?.imageDataUrl).toBeNull();
    expect(final?.capture.redaction.imageExcluded).toBe(true);
    expect(final?.capture.geometry?.image).toBeNull();

    const restarted = spool.open();
    expect((await restarted.read(created.captureId))?.capture.redaction.imageExcluded).toBe(true);
  });

  test("rejects invalid replacement images and unknown captures", async () => {
    const spool = harness();
    const created = await spool.store.create(createInput());
    for (const imageDataUrl of [
      "data:image/jpeg;base64,AAAA",
      "data:image/png;base64,not base64!",
      `data:image/png;base64,${Buffer.from("not a png at all").toString("base64")}`,
      pngDataUrl(2_001, 1),
    ]) {
      await expect(
        spool.store.replaceImage(created.captureId, { imageDataUrl, manualRegions: 0 }),
      ).rejects.toThrow();
    }
    await expect(
      spool.store.replaceImage(created.captureId, { imageDataUrl: null, manualRegions: 33 }),
    ).rejects.toThrow("redaction region");
    await expect(
      spool.store.replaceImage(createBrowserPreviewCaptureId(), {
        imageDataUrl: null,
        manualRegions: 0,
      }),
    ).rejects.toMatchObject({ code: "not-found" });
    expect((await spool.store.read(created.captureId))?.imageDataUrl).toBe(pngDataUrl(64, 40, 1));
  });

  test("rejects a duplicate capture id and invalid capture metadata", async () => {
    const spool = harness();
    const input = createInput();
    await spool.store.create(input);
    await expect(spool.store.create(input)).rejects.toThrow("already spooled");
    await expect(
      spool.store.create({
        ...createInput(),
        capture: { ...input.capture, producer: "legacy-import" as never },
      }),
    ).rejects.toMatchObject({ code: "invalid" });
  });
});
