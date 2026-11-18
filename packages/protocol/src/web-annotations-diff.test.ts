import { describe, expect, it } from "bun:test";
import {
  WEB_ANNOTATION_DIFF_LIMITS,
  WEB_ANNOTATION_DIFF_REFUSALS,
  compareWebAnnotationRasters,
  webAnnotationDiffRefusal,
  type WebAnnotationRaster,
} from "./web-annotations-diff.js";
import { validateWebAnnotationResultCaptureMetadata } from "./web-annotations-validation.js";

function raster(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number] = () => [240, 240, 240],
): WebAnnotationRaster {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x, y);
      data.set([r, g, b, 255], (y * width + x) * 4);
    }
  }
  return { width, height, channels: 4, data };
}

const inside = (x: number, y: number, rect: { x: number; y: number; w: number; h: number }) =>
  x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;

describe("compareWebAnnotationRasters", () => {
  it("finds nothing in identical images", () => {
    const result = compareWebAnnotationRasters(raster(40, 30), raster(40, 30));
    expect(result).toMatchObject({
      timedOut: false,
      changedPixels: 0,
      comparedPixels: 1200,
      excludedPixels: 0,
      regions: [],
      truncatedRegions: false,
      bounds: null,
    });
  });

  it("marks a changed block as one region aligned to the cell grid", () => {
    const block = { x: 10, y: 9, w: 8, h: 5 };
    const after = raster(40, 30, (x, y) => (inside(x, y, block) ? [20, 20, 200] : [240, 240, 240]));
    const result = compareWebAnnotationRasters(raster(40, 30), after, { cellPixels: 8 });
    if (result.timedOut) throw new Error("unexpected timeout");
    expect(result.changedPixels).toBe(40);
    expect(result.regions).toEqual([
      { rect: { x: 8, y: 8, width: 16, height: 8 }, changedPixels: 40 },
    ]);
    expect(result.bounds).toEqual({ x: 8, y: 8, width: 16, height: 8 });
  });

  it("ignores differences within the channel tolerance and single noisy pixels", () => {
    const noisy = raster(40, 30, (x, y) =>
      x === 3 && y === 3
        ? [0, 0, 0]
        : [240 - WEB_ANNOTATION_DIFF_LIMITS.channelTolerance, 240, 240],
    );
    const result = compareWebAnnotationRasters(raster(40, 30), noisy);
    if (result.timedOut) throw new Error("unexpected timeout");
    // The one black pixel counts as changed, but its cell needs two to form a region.
    expect(result.changedPixels).toBe(1);
    expect(result.regions).toEqual([]);
  });

  it("never compares excluded rectangles, rounding them outward", () => {
    const block = { x: 0, y: 0, w: 10, h: 10 };
    const after = raster(40, 30, (x, y) => (inside(x, y, block) ? [0, 0, 0] : [240, 240, 240]));
    const result = compareWebAnnotationRasters(raster(40, 30), after, {
      excluded: [{ x: 0.5, y: 0.5, width: 9, height: 9 }],
    });
    if (result.timedOut) throw new Error("unexpected timeout");
    expect(result.changedPixels).toBe(0);
    expect(result.excludedPixels).toBe(100);
    expect(result.comparedPixels).toBe(1100);
  });

  it("joins diagonally touching cells and keeps the largest regions when truncated", () => {
    const after = raster(64, 64, (x, y) => {
      // Two diagonal 8px blocks (one region) and four separate small marks.
      if (inside(x, y, { x: 0, y: 0, w: 8, h: 8 }) || inside(x, y, { x: 8, y: 8, w: 8, h: 8 })) {
        return [0, 0, 0];
      }
      for (const mx of [40, 56]) {
        for (const my of [40, 56]) {
          if (inside(x, y, { x: mx, y: my, w: 2, h: 2 })) return [0, 0, 0];
        }
      }
      return [240, 240, 240];
    });
    const result = compareWebAnnotationRasters(raster(64, 64), after, { maxRegions: 2 });
    if (result.timedOut) throw new Error("unexpected timeout");
    expect(result.truncatedRegions).toBe(true);
    expect(result.regions).toHaveLength(2);
    expect(result.regions[0]).toEqual({
      rect: { x: 0, y: 0, width: 16, height: 16 },
      changedPixels: 128,
    });
    expect(result.bounds).toEqual({ x: 0, y: 0, width: 64, height: 64 });
  });

  it("stops at the deadline", () => {
    let calls = 0;
    const result = compareWebAnnotationRasters(raster(40, 200), raster(40, 200), {
      deadline: 1,
      now: () => (calls++ === 0 ? 0 : 2),
    });
    expect(result).toEqual({ timedOut: true });
  });

  it("times out inside a large connected region after the raster scan", () => {
    let reads = 0;
    const result = compareWebAnnotationRasters(
      raster(40, 30),
      raster(40, 30, () => [0, 0, 0]),
      {
        cellPixels: 1,
        minCellPixels: 1,
        deadline: 1,
        now: () => (++reads < 4 ? 0 : 1),
      },
    );
    expect(result).toEqual({ timedOut: true });
    expect(reads).toBe(4);
  });

  it("refuses rasters of different sizes rather than resizing", () => {
    expect(() => compareWebAnnotationRasters(raster(40, 30), raster(41, 30))).toThrow(
      "same size and layout",
    );
  });
});

describe("diff refusals", () => {
  it("has a fixed, content-free message for every code", () => {
    for (const code of Object.keys(WEB_ANNOTATION_DIFF_REFUSALS) as Array<
      keyof typeof WEB_ANNOTATION_DIFF_REFUSALS
    >) {
      const message = WEB_ANNOTATION_DIFF_REFUSALS[code];
      expect(message.length).toBeGreaterThan(10);
      expect(webAnnotationDiffRefusal(code)).toEqual({
        code,
        message,
      });
    }
  });
});

describe("unstable-region metadata", () => {
  it("accepts a bounded list of rectangles, an empty list included", () => {
    expect(validateWebAnnotationResultCaptureMetadata({ unstableRegions: [] })).toEqual({
      ok: true,
      value: { unstableRegions: [] },
    });
    const valid = validateWebAnnotationResultCaptureMetadata({
      unstableRegions: [{ x: 0, y: 120, width: 64, height: 32, extra: "dropped" }],
    });
    expect(valid).toEqual({
      ok: true,
      value: { unstableRegions: [{ x: 0, y: 120, width: 64, height: 32 }] },
    });
  });

  it("refuses malformed or oversized lists", () => {
    const rect = { x: 0, y: 0, width: 1, height: 1 };
    for (const unstableRegions of [
      "all",
      [{ x: 0, y: 0, width: -1, height: 1 }],
      Array.from({ length: WEB_ANNOTATION_DIFF_LIMITS.unstableRegions + 1 }, () => rect),
    ]) {
      expect(validateWebAnnotationResultCaptureMetadata({ unstableRegions })).toEqual({
        ok: false,
        error: "unstableRegions are invalid",
      });
    }
  });
});
