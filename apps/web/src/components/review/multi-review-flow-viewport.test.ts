import { describe, expect, test } from "bun:test";
import { multiReviewFlowLayout } from "./multi-review-flow";
import {
  FLOW_VIEWPORT_MAX_HEIGHT,
  FLOW_ZOOM_MAX,
  FLOW_ZOOM_MIN,
  canZoomIn,
  canZoomOut,
  clampFlowZoom,
  fitFlowZoom,
  flowContentOffset,
  flowViewportHeight,
  fitStackedFlowZoom,
  pinchFlowZoom,
  revealFlowRect,
  steppedFlowZoom,
  wheelZoomFactor,
  zoomFlowView,
} from "./multi-review-flow-viewport";

function graph(reviewerCount: number, width = 1440) {
  const layout = multiReviewFlowLayout({ width, reviewerCount, packageHasChips: true });
  return {
    layout,
    content: { width: layout.width, height: layout.height },
    viewport: { width, height: flowViewportHeight(layout.height) },
  };
}

describe("zoom bounds", () => {
  test("clamps every zoom between 20% and 200%", () => {
    expect(clampFlowZoom(0.05)).toBe(FLOW_ZOOM_MIN);
    expect(clampFlowZoom(9)).toBe(FLOW_ZOOM_MAX);
    expect(clampFlowZoom(0.8)).toBe(0.8);
    expect(clampFlowZoom(Number.NaN)).toBe(1);
  });

  test("steps through the presets and stops at either end", () => {
    expect(steppedFlowZoom(1, 1)).toBe(1.25);
    expect(steppedFlowZoom(1, -1)).toBe(0.8);
    // A fitted zoom between two presets steps to the next one either way.
    expect(steppedFlowZoom(0.29, 1)).toBe(0.33);
    expect(steppedFlowZoom(0.29, -1)).toBe(0.25);
    expect(steppedFlowZoom(FLOW_ZOOM_MAX, 1)).toBe(FLOW_ZOOM_MAX);
    expect(steppedFlowZoom(FLOW_ZOOM_MIN, -1)).toBe(FLOW_ZOOM_MIN);
    expect(canZoomIn(FLOW_ZOOM_MAX)).toBe(false);
    expect(canZoomOut(FLOW_ZOOM_MIN)).toBe(false);
    expect(canZoomIn(1) && canZoomOut(1)).toBe(true);
  });

  test("caps a mouse-wheel notch and keeps pinch deltas gentle", () => {
    expect(wheelZoomFactor(-100, 0)).toBeCloseTo(2 ** 0.5);
    expect(wheelZoomFactor(100, 0)).toBeCloseTo(2 ** -0.5);
    const pinch = wheelZoomFactor(-4, 0);
    expect(pinch).toBeGreaterThan(1);
    expect(pinch).toBeLessThan(1.1);
  });
});

describe("viewport and fit", () => {
  test("keeps up to eight reviewers whole at 100% and caps taller panels", () => {
    expect(graph(8).viewport.height).toBe(graph(8).layout.height);
    expect(graph(32).viewport.height).toBe(FLOW_VIEWPORT_MAX_HEIGHT);
    expect(graph(1).viewport.height).toBe(graph(1).layout.height);
  });

  test("fits nothing tighter than the content needs and never magnifies", () => {
    // Wide enough for the PR column as well, so nothing scrolls at 100%.
    const small = graph(2, 2000);
    expect(fitFlowZoom(small.content, small.viewport)).toBe(1);
    const full = graph(32);
    const zoom = fitFlowZoom(full.content, full.viewport);
    expect(zoom).toBeLessThan(0.33);
    expect(zoom).toBeGreaterThanOrEqual(FLOW_ZOOM_MIN);
    // The whole 32-reviewer graph lies inside the viewport at that zoom.
    const offset = flowContentOffset(zoom, full.content, full.viewport);
    expect(offset.x + full.content.width * zoom).toBeLessThanOrEqual(full.viewport.width);
    expect(offset.y + full.content.height * zoom).toBeLessThanOrEqual(full.viewport.height);
    expect(offset.x).toBeGreaterThan(0);
  });

  test("fits the full panel in a narrow pane too", () => {
    const narrow = graph(32, 960);
    const zoom = fitFlowZoom(narrow.content, narrow.viewport);
    expect(narrow.content.width * zoom).toBeLessThanOrEqual(narrow.viewport.width);
    expect(narrow.content.height * zoom).toBeLessThanOrEqual(narrow.viewport.height);
  });
});

describe("zooming around a point", () => {
  test("keeps the canvas point under the pointer where it was", () => {
    const { content, viewport } = graph(8);
    const anchor = { x: 300, y: 200 };
    const view = zoomFlowView(
      { zoom: 1, scrollLeft: 0, scrollTop: 0 },
      2,
      content,
      viewport,
      anchor,
    );
    expect(view.zoom).toBe(2);
    // Canvas point (300, 200) sits under the anchor at 2x.
    expect(view.scrollLeft).toBe(300);
    expect(view.scrollTop).toBe(200);
  });

  test("clamps the scroll to the content and centres a canvas smaller than the viewport", () => {
    const { content, viewport } = graph(8);
    // Scrolled to the far right, so the anchor is the canvas's bottom-right corner.
    const start = { zoom: 1, scrollLeft: content.width - viewport.width, scrollTop: 0 };
    const zoomedIn = zoomFlowView(start, 2, content, viewport, {
      x: viewport.width,
      y: viewport.height,
    });
    expect(zoomedIn.scrollLeft).toBe(content.width * 2 - viewport.width);
    expect(zoomedIn.scrollTop).toBe(content.height * 2 - viewport.height);
    const zoomedOut = zoomFlowView(zoomedIn, 0.5, content, viewport);
    expect(zoomedOut).toEqual({ zoom: 0.5, scrollLeft: 0, scrollTop: 0 });
  });

  test("refuses a zoom outside the bounds", () => {
    const { content, viewport } = graph(2);
    expect(zoomFlowView({ zoom: 1, scrollLeft: 0, scrollTop: 0 }, 40, content, viewport).zoom).toBe(
      FLOW_ZOOM_MAX,
    );
  });
});

describe("keeping a node in view", () => {
  test("scrolls just far enough to show a node below the viewport", () => {
    const { layout, content, viewport } = graph(32);
    const last = layout.reviewers[31]!;
    const view = revealFlowRect({ zoom: 1, scrollLeft: 0, scrollTop: 0 }, last, content, viewport);
    expect(view.scrollTop).toBe(last.y + last.height + 24 - viewport.height);
    expect(last.y - view.scrollTop).toBeGreaterThanOrEqual(0);
    expect(last.y + last.height - view.scrollTop).toBeLessThanOrEqual(viewport.height);
  });

  test("leaves the scroll alone when the node is already visible", () => {
    const { layout, content, viewport } = graph(32);
    const start = { zoom: 1, scrollLeft: 0, scrollTop: 0 };
    expect(revealFlowRect(start, layout.reviewers[0]!, content, viewport)).toEqual(start);
  });

  test("accounts for the zoom and scrolls back up to an earlier node", () => {
    const { layout, content, viewport } = graph(32);
    const view = revealFlowRect(
      { zoom: 1.5, scrollLeft: 900, scrollTop: 3_000 },
      layout.package,
      content,
      viewport,
    );
    const offset = flowContentOffset(1.5, content, viewport);
    expect(view.scrollTop).toBe(Math.round(layout.package.y * 1.5 + offset.y - 24));
    expect(view.scrollLeft).toBe(0);
  });
});

describe("touch pinch and the stacked Fit", () => {
  test("a pinch scales the zoom it started from, within bounds", () => {
    expect(pinchFlowZoom(1, 100, 150)).toBe(1.5);
    expect(pinchFlowZoom(0.5, 200, 100)).toBe(0.25);
    expect(pinchFlowZoom(1, 100, 1_000)).toBe(FLOW_ZOOM_MAX);
    expect(pinchFlowZoom(1, 100, 1)).toBe(FLOW_ZOOM_MIN);
    // Fingers that started together give no ratio to scale by.
    expect(pinchFlowZoom(0.8, 0, 50)).toBe(0.8);
  });

  test("Fit sizes the stacked column to the visible height and never magnifies", () => {
    expect(fitStackedFlowZoom(2_000, 800)).toBeCloseTo(0.4);
    expect(fitStackedFlowZoom(400, 800)).toBe(1);
    expect(fitStackedFlowZoom(40_000, 800)).toBe(FLOW_ZOOM_MIN);
    expect(fitStackedFlowZoom(2_000, null)).toBe(1);
    expect(fitStackedFlowZoom(0, 800)).toBe(1);
  });
});
