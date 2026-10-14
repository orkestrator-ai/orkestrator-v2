import { describe, expect, spyOn, test } from "bun:test";
import { fixtureAnchor } from "@orkestrator/protocol/web-annotations-fixtures";
import { validateWebAnnotationCaptureInput } from "@orkestrator/protocol/web-annotations-validation";
import {
  createHarness,
  elementSelection,
  fakeImage,
  start,
  type CaptureContents,
  type Json,
} from "./browser-preview-capture-harness";

const MASK = [0x28, 0x23, 0x1f, 0xff];

function pixel(bitmap: Buffer, width: number, x: number, y: number): number[] {
  const offset = (y * width + x) * 4;
  return Array.from(bitmap.subarray(offset, offset + 4));
}

const regionSelection = (
  viewport: { width: number; height: number },
  scroll: Json,
  dpr: number,
) => ({
  target: {
    kind: "region",
    label: "Region",
    rect: { x: 100, y: 50, width: 320, height: 120 },
    imageRect: null,
  },
  evidence: null,
  redaction: { attributesRemoved: 0, valuesMasked: 0, urlParametersRemoved: 0 },
  title: "",
  viewport,
  scroll,
  devicePixelRatio: dpr,
});

async function captured(harness: ReturnType<typeof createHarness>) {
  const status = await harness.manager.getCaptureStatus("browser-1");
  if (status.status !== "captured")
    throw new Error(`expected capture, got ${JSON.stringify(status)}`);
  return { status, pending: (await harness.manager.readPendingCapture(status.captureId))! };
}

describe("geometry at multiple zoom levels, device scales, and scroll offsets", () => {
  test.each([0.75, 1.25, 2])(
    "maps every sensitive pixel with retained native scale %s",
    async (factor) => {
      const harness = createHarness({ cropping: true });
      const contents = await harness.attach();
      // CSS viewport and NativeImage DIPs differ too (zoom/emulation).
      const viewport = { width: 1_000, height: 600 };
      const width = 800 * factor;
      const height = 500 * factor;
      const scaleX = width / viewport.width;
      const scaleY = height / viewport.height;
      const image = fakeImage(width, height);
      image.getSize = () => ({ width: 800, height: 500 });
      image.getScaleFactors = () => [factor];
      const toBitmap = spyOn(image, "toBitmap");
      contents.capturePage.mockResolvedValue(image);
      contents.probe = {
        connected: true,
        rect: { x: 100, y: 50, width: 320, height: 120 },
        viewport,
        scroll: { x: 0, y: 0 },
        devicePixelRatio: 3,
        sensitive: [{ x: 500.25, y: 400.25, width: 99.5, height: 39.5 }],
      };
      await start(harness.manager, "region");
      contents.selection = regionSelection(viewport, { x: 0, y: 0 }, 3);
      const { pending } = await captured(harness);
      expect(toBitmap).toHaveBeenCalledWith({ scaleFactor: factor });
      expect(pending.capture.redaction.imageExcluded).toBe(false);
      expect(pending.capture.geometry?.image).toEqual({
        width,
        height,
        scale: scaleX,
        reduced: false,
      });
      const bitmap = harness.bitmaps[0]!;
      const x0 = Math.floor(500.25 * scaleX);
      const x1 = Math.ceil(599.75 * scaleX);
      const y0 = Math.floor(400.25 * scaleY);
      const y1 = Math.ceil(439.75 * scaleY);
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) expect(pixel(bitmap, width, x, y)).toEqual(MASK);
      }
      expect(pixel(bitmap, width, x0 - 1, y0)).not.toEqual(MASK);
      expect(pixel(bitmap, width, x1, y0)).not.toEqual(MASK);
      expect(pending.regionCrop).toMatchObject({
        width: Math.round(320 * scaleX),
        height: Math.round(120 * scaleX),
      });
    },
  );

  const cases = [
    { zoom: 0.5, dpr: 1 },
    { zoom: 1, dpr: 2 },
    { zoom: 2, dpr: 3 },
  ];
  for (const { zoom, dpr } of cases) {
    test(`zoom ${zoom} and device scale ${dpr}: image transform, region crop, and mask alignment`, async () => {
      const harness = createHarness({ cropping: true });
      const contents = await harness.attach();
      const viewport = { width: 1_000, height: 600 };
      const scroll = { x: 40, y: 300 };
      contents.zoom = zoom;
      contents.image = { width: viewport.width * dpr, height: viewport.height * dpr };
      contents.probe = {
        connected: true,
        rect: { x: 100, y: 50, width: 320, height: 120 },
        viewport,
        scroll,
        devicePixelRatio: dpr,
        sensitive: [{ x: 500, y: 400, width: 100, height: 40 }],
      };
      await start(harness.manager, "region");
      contents.selection = regionSelection(viewport, scroll, dpr);

      const { pending } = await captured(harness);
      const nativeWidth = viewport.width * dpr;
      const stored = Math.min(nativeWidth, 2_000);
      const scale = stored / viewport.width;
      expect(pending.capture.geometry).toEqual({
        viewport,
        scroll,
        zoomFactor: zoom,
        devicePixelRatio: dpr,
        image: {
          width: stored,
          height: Math.round(viewport.height * dpr * (stored / nativeWidth)),
          scale,
          reduced: nativeWidth > 2_000,
        },
      });
      const imageRect = {
        x: Math.round(100 * scale),
        y: Math.round(50 * scale),
        width: Math.round(320 * scale),
        height: Math.round(120 * scale),
      };
      expect(pending.capture.target).toMatchObject({ kind: "region", imageRect });
      expect(pending.regionCrop).toMatchObject({
        sourceRect: imageRect,
        width: imageRect.width,
        height: imageRect.height,
      });
      // The mask is stored in document coordinates (viewport rect + scroll).
      expect(pending.masks).toEqual([
        { source: "sensitive-field", rect: { x: 540, y: 700, width: 100, height: 40 } },
      ]);
      // Pixels were painted at the native (device-scaled) position before downscaling.
      const bitmap = harness.bitmaps[0]!;
      expect(pixel(bitmap, nativeWidth, 500 * dpr + 1, 400 * dpr + 1)).toEqual(MASK);
      expect(pixel(bitmap, nativeWidth, 500 * dpr - 2, 400 * dpr - 2)).not.toEqual(MASK);
      expect(validateWebAnnotationCaptureInput(pending.capture).ok).toBe(true);
    });
  }
});

describe("capture lifecycle hazards", () => {
  test("hot reload replacing the target during capture spools a stale capture", async () => {
    const harness = createHarness();
    const contents = await harness.attach();
    await start(harness.manager);
    contents.selection = elementSelection();
    // HMR swaps the DOM between the screenshot and the post-capture probe, twice.
    const detached = { ...contents.probe, connected: false };
    contents.probes = [contents.probe, detached, detached];
    const { status, pending } = await captured(harness);
    expect(status.pending.stale).toBe(true);
    expect(pending.capture.stale?.reason).toContain("removed");
  });

  test("a reload during capture marks it stale and drops pixels from the next document", async () => {
    const harness = createHarness();
    const contents = await harness.attach();
    await start(harness.manager);
    contents.selection = elementSelection();
    contents.onCapture = () => contents.reloadDocument();
    const { pending } = await captured(harness);
    expect(pending.imageDataUrl).toBeNull();
    expect(pending.capture.stale?.reason).toContain("navigated");
  });

  test("an image write failure reports an error, spools nothing, and the next capture works", async () => {
    let failNext = true;
    const harness = createHarness({
      wrapStore: (store) =>
        Object.assign(Object.create(store), {
          create: (input: Parameters<typeof store.create>[0]) => {
            if (failNext) {
              failNext = false;
              return Promise.reject(
                Object.assign(new Error("ENOSPC: no space left"), { code: "ENOSPC" }),
              );
            }
            return store.create(input);
          },
        }),
    });
    const contents = await harness.attach();
    await start(harness.manager);
    contents.selection = elementSelection();
    const status = await harness.manager.getCaptureStatus("browser-1");
    expect(status).toMatchObject({ status: "error", code: "capture-failed" });
    expect(JSON.stringify(status)).not.toContain("ENOSPC");
    expect(await harness.manager.listPendingCaptures()).toEqual([]);
    expect(harness.events.some((event) => event.status === "captured")).toBe(false);

    await start(harness.manager);
    contents.selection = elementSelection();
    expect((await harness.manager.getCaptureStatus("browser-1")).status).toBe("captured");
    expect(await harness.manager.listPendingCaptures()).toHaveLength(1);
  });

  test("synthetic secrets in page evidence never reach logs or events", async () => {
    const secret = "sk-synthetic-SECRET-4242";
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const spies = methods.map((method) =>
      spyOn(console, method).mockImplementation(() => undefined),
    );
    try {
      const harness = createHarness();
      const contents = await harness.attach(`http://localhost:5173/settings?api_key=${secret}`);
      contents.title = `Account ${secret}`;
      await start(harness.manager);
      const selection = elementSelection();
      contents.selection = {
        ...selection,
        evidence: {
          ...selection.evidence,
          text: `Token ${secret}`,
          html: `<button data-token="${secret}">Save</button>`,
        },
      };
      const { status } = await captured(harness);
      await harness.manager.replacePendingCaptureImage(status.captureId, {
        imageDataUrl: null,
        manualRegions: 0,
      });
      await harness.manager.acknowledgePendingCapture({
        captureId: status.captureId,
        annotationId: "annotation-1",
        backendCaptureId: "capture-b1",
      });
      await harness.manager.startCapture({
        tabId: "browser-1",
        mode: "element",
        environmentId: "env-fixture",
      });
      contents.rawStatus = () => JSON.stringify({ v: 1, status: "error", error: { code: secret } });
      await harness.manager.getCaptureStatus("browser-1");
      for (const spy of spies) {
        expect(JSON.stringify(spy.mock.calls)).not.toContain(secret);
      }
      expect(JSON.stringify(harness.events)).not.toContain(secret);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe("focus handoff", () => {
  test("a spooled capture returns focus to the app window and asks the editor to take it", async () => {
    const harness = createHarness();
    const contents = await harness.attach();
    await start(harness.manager);
    expect(contents.focus).toHaveBeenCalled();
    expect(harness.hostFocus).not.toHaveBeenCalled();
    contents.selection = elementSelection();
    await harness.manager.getCaptureStatus("browser-1");
    expect(harness.hostFocus).toHaveBeenCalledTimes(1);
    expect(harness.events.at(-1)).toMatchObject({ status: "captured", focus: "editor" });
  });

  test("Escape in the page does not pull focus out of the preview", async () => {
    const harness = createHarness();
    const contents = await harness.attach();
    await start(harness.manager);
    contents.rawStatus = (config) => JSON.stringify({ v: 1, ...config, status: "cancelled" });
    await harness.manager.getCaptureStatus("browser-1");
    expect(harness.hostFocus).not.toHaveBeenCalled();
    expect(harness.events.at(-1)).toEqual({
      tabId: "browser-1",
      captureId: expect.any(String),
      status: "cancelled",
    });
  });
});

describe("recapture of a stale pending capture", () => {
  test("starts on the same target and replaces the stale record, even at capacity", async () => {
    const harness = createHarness({ perPreview: 1 });
    const contents = await harness.attach();
    await start(harness.manager, "element", { annotationId: "annotation-7" });
    contents.selection = elementSelection();
    contents.onCapture = () => contents.reloadDocument();
    const first = await captured(harness);
    expect(first.status.pending.stale).toBe(true);
    contents.onCapture = () => undefined;

    // A different mode and annotation in the request are ignored: the old record decides.
    const restarted = await harness.manager.startCapture({
      tabId: "browser-1",
      mode: "page",
      environmentId: "env-other",
      recaptureCaptureId: first.status.captureId,
    });
    expect(restarted).toMatchObject({ status: "selecting", mode: "element" });
    expect((contents as CaptureContents).config?.initialTarget).toEqual({
      kind: "element",
      anchor: fixtureAnchor,
    });
    contents.selection = elementSelection();
    const second = await captured(harness);
    expect(second.status.pending).toMatchObject({
      recaptureOf: first.status.captureId,
      annotationId: "annotation-7",
      environmentId: "env-fixture",
      stale: false,
    });
    expect((await harness.manager.listPendingCaptures()).map((entry) => entry.captureId)).toEqual([
      second.status.captureId,
    ]);
  });

  test("a recapture of a capture that is no longer pending is refused", async () => {
    const harness = createHarness();
    await harness.attach();
    const status = await harness.manager.startCapture({
      tabId: "browser-1",
      mode: "element",
      environmentId: "env-fixture",
      recaptureCaptureId: "capture-00000000-0000-4000-8000-000000000000",
    });
    expect(status).toMatchObject({ status: "error", code: "stale-session" });
  });
});

describe("result capture", () => {
  const manualMask = { source: "manual" as const, rect: { x: 200, y: 220, width: 50, height: 30 } };
  const startResult = (harness: ReturnType<typeof createHarness>, result: Json) =>
    harness.manager.startCapture({
      tabId: "browser-1",
      mode: "page",
      environmentId: "env-fixture",
      purpose: "result",
      result: { requestId: "request-1", ...result },
    });

  test("waits for stability, records metadata, and repaints the original masks", async () => {
    const harness = createHarness();
    const contents = await harness.attach();
    // The page is scrolled to y=120 now; the original mask was at document y=220.
    const status = await startResult(harness, { masks: [manualMask] });
    expect(status.status).toBe("captured");
    expect(contents.settleCalls).toBe(1);
    const pending = (await harness.manager.readPendingCapture((status as Json).captureId))!;
    expect(pending.capture.producer).toBe("result-capture");
    expect(pending.descriptor.purpose).toBe("result");
    expect(pending.result).toEqual({
      zoomFactor: 1.25,
      deviceScaleFactor: 2,
      scroll: { x: 0, y: 120 },
      stability: "stable",
      masks: [
        { source: "sensitive-field", rect: { x: 10, y: 130, width: 100, height: 20 } },
        manualMask,
      ],
    });
    // Reapplied at viewport y = 220 - 120 = 100 CSS px → native 200 px at 2×.
    const bitmap = harness.bitmaps.at(-1)!;
    expect(pixel(bitmap, 1_600, 401, 201)).toEqual(MASK);
    expect(pixel(bitmap, 1_600, 398, 198)).not.toEqual(MASK);
  });

  test("an unsettled page is captured and labelled unstable, not stale", async () => {
    const harness = createHarness();
    const contents = await harness.attach();
    contents.settle = { stable: false, fontsReady: true };
    const moving = { ...contents.probe, rect: { x: 0, y: 0, width: 10, height: 10 } };
    contents.probes = [contents.probe, moving, contents.probe, moving];
    const status = await startResult(harness, {});
    const pending = (await harness.manager.readPendingCapture((status as Json).captureId))!;
    expect(pending.result?.stability).toBe("unstable");
    expect(pending.capture.stale).toBeUndefined();
    expect(pending.imageDataUrl).not.toBeNull();
  });

  test("masks remembered from the acknowledged original capture are reapplied", async () => {
    const harness = createHarness();
    const contents = await harness.attach();
    await start(harness.manager);
    contents.selection = elementSelection();
    const original = await captured(harness);
    await harness.manager.replacePendingCaptureImage(original.status.captureId, {
      imageDataUrl: original.pending.imageDataUrl,
      manualRegions: 0,
      regions: [{ x: 400, y: 200, width: 100, height: 60 }],
    });
    await harness.manager.acknowledgePendingCapture({
      captureId: original.status.captureId,
      annotationId: "annotation-1",
      backendCaptureId: "capture-original",
    });
    const status = await startResult(harness, { originalCaptureId: "capture-original" });
    const pending = (await harness.manager.readPendingCapture((status as Json).captureId))!;
    expect(pending.result?.masks).toContainEqual({
      source: "manual",
      rect: { x: 200, y: 220, width: 50, height: 30 },
    });
  });

  test("a result capture requires a request id", async () => {
    const harness = createHarness();
    await harness.attach();
    await expect(
      harness.manager.startCapture({
        tabId: "browser-1",
        mode: "page",
        environmentId: "env-fixture",
        purpose: "result",
      }),
    ).rejects.toThrow("request");
  });
});

describe("capabilities and receipts through the manager", () => {
  test("advertises the capture contract and records receipts", async () => {
    const harness = createHarness({ cropping: true });
    const contents = await harness.attach();
    expect(harness.manager.getCaptureCapabilities()).toMatchObject({
      contractVersion: 2,
      modes: ["element", "text", "region", "page"],
      features: { regionCrop: true, recapture: true, responsiveSets: { maxWidths: 4 } },
    });
    await start(harness.manager);
    contents.selection = elementSelection();
    const { status } = await captured(harness);
    const ack = {
      captureId: status.captureId,
      annotationId: "annotation-1",
      backendCaptureId: "capture-b1",
    };
    await harness.manager.recordPendingCaptureReceipt(ack);
    expect((await harness.manager.listPendingCaptures())[0]?.receipt).toEqual({
      annotationId: "annotation-1",
      backendCaptureId: "capture-b1",
    });
    expect(harness.events.at(-1)).toMatchObject({ status: "captured" });
  });
});
