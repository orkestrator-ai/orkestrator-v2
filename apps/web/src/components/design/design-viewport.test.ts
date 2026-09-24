import { describe, expect, test } from "bun:test";
import {
  DEFAULT_VIEWPORT,
  MAX_ZOOM,
  MIN_ZOOM,
  boundsOf,
  clampCoordinate,
  clampDimension,
  clampZoom,
  fitBounds,
  restoreViewport,
  toCanvas,
  toScreen,
  wheelAction,
  zoomAt,
} from "./design-viewport";
import { planLiveFrames } from "./design-visibility";

describe("design viewport math", () => {
  test("frame ↔ viewport conversions round trip", () => {
    const viewport = { panX: 37, panY: -12, zoom: 0.37 };
    for (const point of [
      { x: 0, y: 0 },
      { x: -2400, y: 812 },
      { x: 99_999, y: -99_999 },
    ]) {
      const back = toCanvas(viewport, toScreen(viewport, point));
      expect(back.x).toBeCloseTo(point.x, 6);
      expect(back.y).toBeCloseTo(point.y, 6);
    }
  });

  test("pointer-anchored zoom keeps the canvas point under the pointer fixed", () => {
    const viewport = { panX: 100, panY: 50, zoom: 1 };
    const anchor = { x: 420, y: 300 };
    const before = toCanvas(viewport, anchor);
    const zoomed = zoomAt(viewport, anchor, 2.5);
    const after = toCanvas(zoomed, anchor);
    expect(zoomed.zoom).toBe(2.5);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  test("zoom is clamped to supported bounds", () => {
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(DEFAULT_VIEWPORT.zoom);
    expect(zoomAt({ panX: 0, panY: 0, zoom: 1 }, { x: 0, y: 0 }, 1e9).zoom).toBe(MAX_ZOOM);
  });

  test("fit includes negative coordinates and frame chrome and centers the content", () => {
    const frames = [
      { x: -1200, y: -300, width: 400, height: 300 },
      { x: 800, y: 900, width: 1440, height: 900 },
    ];
    const bounds = boundsOf(frames)!;
    expect(bounds.x).toBeLessThan(-1200);
    expect(bounds.y).toBeLessThan(-300);
    const size = { width: 1000, height: 700 };
    const fit = fitBounds(bounds, size, { padding: 40 });
    const topLeft = toScreen(fit, { x: bounds.x, y: bounds.y });
    const bottomRight = toScreen(fit, { x: bounds.x + bounds.width, y: bounds.y + bounds.height });
    expect(topLeft.x).toBeGreaterThanOrEqual(39.9);
    expect(topLeft.y).toBeGreaterThanOrEqual(39.9);
    expect(bottomRight.x).toBeLessThanOrEqual(960.1);
    expect(bottomRight.y).toBeLessThanOrEqual(660.1);
    expect(fitBounds(null, size)).toEqual(DEFAULT_VIEWPORT);
  });

  test("wheel modifiers: ctrl/meta zooms, shift pans horizontally, line mode scales", () => {
    expect(
      wheelAction({
        deltaX: 0,
        deltaY: 100,
        deltaMode: 0,
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
      }),
    ).toMatchObject({
      kind: "zoom",
    });
    expect(
      wheelAction({
        deltaX: 0,
        deltaY: 30,
        deltaMode: 0,
        ctrlKey: false,
        metaKey: false,
        shiftKey: true,
      }),
    ).toEqual({
      kind: "pan",
      dx: 30,
      dy: 0,
    });
    expect(
      wheelAction({
        deltaX: 0,
        deltaY: 3,
        deltaMode: 1,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
      }),
    ).toEqual({
      kind: "pan",
      dx: 0,
      dy: 48,
    });
  });

  test("restoring a view revalidates it against current frames", () => {
    const frames = [{ x: 0, y: 0, width: 800, height: 600 }];
    const size = { width: 1000, height: 800 };
    expect(restoreViewport({ panX: 10, panY: 10, zoom: 0.5 }, frames, size)).toEqual({
      panX: 10,
      panY: 10,
      zoom: 0.5,
    });
    // Content far outside the view resets to fit.
    const far = restoreViewport({ panX: -900_000, panY: 0, zoom: 1 }, frames, size);
    // Fit centers the frame including its chrome (label above, handle below-right).
    const bounds = boundsOf(frames)!;
    const center = toScreen(far, {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    });
    expect(center.x).toBeCloseTo(500, 0);
    expect(center.y).toBeCloseTo(400, 0);
    expect(restoreViewport({ panX: Number.NaN, panY: 0, zoom: 1 }, [], size)).toEqual(
      DEFAULT_VIEWPORT,
    );
  });

  test("dimension and coordinate clamps match backend bounds", () => {
    expect(clampDimension(10)).toBe(32);
    expect(clampDimension(5000)).toBe(4096);
    expect(clampDimension(100.6)).toBe(101);
    expect(clampCoordinate(-200_000)).toBe(-100_000);
    expect(clampCoordinate(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("visible-frame planning", () => {
  const grid = Array.from({ length: 64 }, (_, index) => ({
    id: `f${index}`,
    x: (index % 8) * 900,
    y: Math.floor(index / 8) * 700,
    width: 800,
    height: 600,
  }));

  test("live previews stay within budget while every frame remains discoverable", () => {
    const plan = planLiveFrames({
      frames: grid,
      viewport: { panX: 0, panY: 0, zoom: 0.12 },
      size: { width: 1200, height: 800 },
    });
    expect(plan.live.size).toBeLessThanOrEqual(8);
    expect(plan.visible.size).toBe(64);
  });

  test("pinned frames stay live mid-gesture even offscreen; selected precedes the rest", () => {
    const plan = planLiveFrames({
      frames: grid,
      viewport: { panX: 0, panY: 0, zoom: 1 },
      size: { width: 1200, height: 800 },
      pinned: new Set(["f63"]),
      selected: "f1",
    });
    expect(plan.live.has("f63")).toBe(true);
    expect(plan.live.has("f1")).toBe(true);
    expect(plan.live.has("f0")).toBe(true);
  });

  test("tiny frames at very low zoom use placeholders instead of live iframes", () => {
    const plan = planLiveFrames({
      frames: grid,
      viewport: { panX: 0, panY: 0, zoom: 0.02 },
      size: { width: 1200, height: 800 },
    });
    expect(plan.live.size).toBe(0);
    expect(plan.visible.size).toBe(64);
  });
});
