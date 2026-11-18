/**
 * The unstable-region mask of a result capture (to-do 0047 (retired) task 2): a second
 * sample taken right after the screenshot, compared with it in main, only
 * when the start asks for it (a backend advertising `operations.resultDiffs`).
 */
import { describe, expect, test } from "bun:test";
import { unstableRegionsBetween } from "../electron/browser-preview-capture-image";
import { createHarness, fakeImage, type Json } from "./browser-preview-capture-harness";

const NATIVE = { width: 1_600, height: 1_000 };

/** A white BGRA bitmap with `block` (native pixels) painted black. */
function bitmapWith(block?: { x: number; y: number; width: number; height: number }): Buffer {
  const bitmap = Buffer.alloc(NATIVE.width * NATIVE.height * 4, 0xff);
  if (!block) return bitmap;
  for (let y = block.y; y < block.y + block.height; y += 1) {
    for (let x = block.x; x < block.x + block.width; x += 1) {
      bitmap.fill(0, (y * NATIVE.width + x) * 4, (y * NATIVE.width + x) * 4 + 3);
    }
  }
  return bitmap;
}

const startResult = (harness: ReturnType<typeof createHarness>, result: Json = {}) =>
  harness.manager.startCapture({
    tabId: "browser-1",
    mode: "page",
    environmentId: "env-fixture",
    purpose: "result",
    result: { requestId: "request-1", ...result },
  });

async function pendingResult(harness: ReturnType<typeof createHarness>, status: unknown) {
  expect((status as Json).status).toBe("captured");
  return (await harness.manager.readPendingCaptureWire((status as Json).captureId))!.result!;
}

describe("unstable-region sampling", () => {
  test("is not taken unless the start asks for it", async () => {
    const harness = createHarness();
    const contents = await harness.attach();
    const result = await pendingResult(harness, await startResult(harness));
    expect(result).not.toHaveProperty("unstableRegions");
    expect(contents.capturePage).toHaveBeenCalledTimes(1);
  });

  test("records what moved between two samples, in document CSS pixels", async () => {
    const harness = createHarness();
    const contents = await harness.attach();
    // Native 100..139 × 60..79 at 2× is CSS 50..69 × 30..39; cells are 16 CSS px.
    contents.captureBitmaps = [bitmapWith(), bitmapWith({ x: 100, y: 60, width: 40, height: 20 })];
    const result = await pendingResult(
      harness,
      await startResult(harness, { sampleUnstable: true }),
    );
    expect(contents.capturePage).toHaveBeenCalledTimes(2);
    // Scrolled to y = 120 when captured.
    expect(result.unstableRegions).toEqual([{ x: 48, y: 136, width: 32, height: 32 }]);
    expect(result.stability).toBe("stable");
  });

  test("an unchanged page gives an empty mask, which still counts as sampled", async () => {
    const harness = createHarness();
    await harness.attach();
    const result = await pendingResult(
      harness,
      await startResult(harness, { sampleUnstable: true }),
    );
    expect(result.unstableRegions).toEqual([]);
  });

  test("a page that scrolls between samples gives no mask rather than a wrong one", async () => {
    const harness = createHarness();
    const contents = await harness.attach();
    const scrolled = { ...contents.probe, scroll: { x: 0, y: 400 } };
    contents.probes = [contents.probe, contents.probe, scrolled];
    const result = await pendingResult(
      harness,
      await startResult(harness, { sampleUnstable: true }),
    );
    expect(result).not.toHaveProperty("unstableRegions");
  });

  test("samples whose pixels cannot be read give no mask", async () => {
    const harness = createHarness();
    const contents = await harness.attach();
    contents.bitmapUnavailable = true;
    const result = await pendingResult(
      harness,
      await startResult(harness, { sampleUnstable: true }),
    );
    expect(result).not.toHaveProperty("unstableRegions");
  });

  test("the start flag must be a boolean", async () => {
    const harness = createHarness();
    await harness.attach();
    await expect(startResult(harness, { sampleUnstable: "yes" })).rejects.toThrow("boolean");
  });

  test("is advertised in the desktop capabilities", () => {
    const harness = createHarness();
    expect(harness.manager.getCaptureCapabilities().features.resultCapture).toMatchObject({
      unstableRegions: true,
    });
  });
});

describe("unstableRegionsBetween", () => {
  const viewport = { width: 800, height: 500 };

  test("collapses more regions than the limit into their bounding box", () => {
    const first = Buffer.alloc(NATIVE.width * NATIVE.height * 4, 0xff);
    const second = Buffer.from(first);
    // 40 separate one-pixel changes, every other 32-px cell along two rows.
    for (let index = 0; index < 40; index += 1) {
      const x = (index % 20) * 64;
      const y = Math.floor(index / 20) * 64;
      second[(y * NATIVE.width + x) * 4] = 0;
    }
    const regions = unstableRegionsBetween(
      fakeImage(NATIVE.width, NATIVE.height, first) as never,
      fakeImage(NATIVE.width, NATIVE.height, second) as never,
      viewport,
      { x: 0, y: 0 },
    );
    expect(regions).toEqual([{ x: 0, y: 0, width: 624, height: 48 }]);
  });

  test("refuses samples of different sizes", () => {
    expect(
      unstableRegionsBetween(
        fakeImage(1_600, 1_000) as never,
        fakeImage(1_600, 998) as never,
        viewport,
        { x: 0, y: 0 },
      ),
    ).toBeNull();
  });
});
