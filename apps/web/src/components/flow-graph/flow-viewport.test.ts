import { describe, expect, test } from "bun:test";
import { multiReviewFlowLayout } from "../review/multi-review-flow";
import {
  FLOW_VIEWPORT_MAX_HEIGHT,
  FLOW_VIEWPORT_RESIZE_MIN_HEIGHT,
  resizedFlowViewportHeight,
  FLOW_ZOOM_MAX,
  FLOW_ZOOM_MIN,
  centerFlowRect,
  canZoomIn,
  canZoomOut,
  clampFlowZoom,
  fitFlowView,
  fitStackedFlowZoom,
  flowContentOffset,
  flowViewportHeight,
  pinchFlowZoom,
  revealFlowRect,
  steppedFlowZoom,
  wheelZoomFactor,
  zoomFlowView,
} from "./flow-viewport";

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

describe("viewport", () => {
  test("keeps up to eight reviewers whole at 100% and caps taller panels", () => {
    expect(graph(8).viewport.height).toBe(graph(8).layout.height);
    expect(graph(32).viewport.height).toBe(FLOW_VIEWPORT_MAX_HEIGHT);
    expect(graph(1).viewport.height).toBe(graph(1).layout.height);
  });

  test("centres a canvas smaller than the viewport", () => {
    const full = graph(32);
    const zoom = Math.min(
      full.viewport.width / full.content.width,
      full.viewport.height / full.content.height,
    );
    const offset = flowContentOffset(zoom, full.content, full.viewport);
    expect(offset.x + full.content.width * zoom).toBeLessThanOrEqual(full.viewport.width);
    expect(offset.y + full.content.height * zoom).toBeLessThanOrEqual(full.viewport.height);
    expect(offset.x).toBeGreaterThan(0);
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

describe("touch pinch", () => {
  test("a pinch scales the zoom it started from, within bounds", () => {
    expect(pinchFlowZoom(1, 100, 150)).toBe(1.5);
    expect(pinchFlowZoom(0.5, 200, 100)).toBe(0.25);
    expect(pinchFlowZoom(1, 100, 1_000)).toBe(FLOW_ZOOM_MAX);
    expect(pinchFlowZoom(1, 100, 1)).toBe(FLOW_ZOOM_MIN);
    // Fingers that started together give no ratio to scale by.
    expect(pinchFlowZoom(0.8, 0, 50)).toBe(0.8);
  });
});

describe("centering a stage", () => {
  test.each([0.8, 1.5, 2])(
    "centers canvas coordinates at zoom %s and reveals the vertical bounds",
    (zoom) => {
      const rect = { x: 700, y: 800, width: 200, height: 80 };
      const view = centerFlowRect(
        { zoom, scrollLeft: 10, scrollTop: 0 },
        rect,
        { width: 2000, height: 2000 },
        { width: 600, height: 400 },
      );
      expect(view.zoom).toBe(zoom);
      expect(view.scrollLeft).toBe(Math.round(800 * zoom - 300));
      expect(view.scrollTop).toBe(Math.round(880 * zoom + 24 - 400));
    },
  );

  test("clamps both axes to zero when the scaled canvas is smaller than the viewport", () => {
    expect(
      centerFlowRect(
        { zoom: 0.5, scrollLeft: 300, scrollTop: 500 },
        { x: 900, y: 600, width: 100, height: 80 },
        { width: 1000, height: 700 },
        { width: 1200, height: 800 },
      ),
    ).toEqual({ zoom: 0.5, scrollLeft: 0, scrollTop: 0 });
  });
});

describe("resized viewport height", () => {
  test("clamps to the minimum and the content-dependent maximum", () => {
    expect(resizedFlowViewportHeight(-100, 200)).toBe(FLOW_VIEWPORT_RESIZE_MIN_HEIGHT);
    expect(resizedFlowViewportHeight(Infinity, 200)).toBe(FLOW_VIEWPORT_MAX_HEIGHT);
    expect(resizedFlowViewportHeight(Infinity, 800.2)).toBe(1601);
    expect(resizedFlowViewportHeight(900, 800)).toBe(900);
  });

  test("rounds requested heights to whole layout pixels", () => {
    expect(resizedFlowViewportHeight(300.49, 800)).toBe(300);
    expect(resizedFlowViewportHeight(300.5, 800)).toBe(301);
  });
});

describe("fit", () => {
  test("zooms a large graph out until all of it shows, from its start", () => {
    const { content, viewport } = graph(32);
    const view = fitFlowView(content, viewport);
    expect(view.zoom).toBeLessThan(1);
    expect(content.width * view.zoom).toBeLessThanOrEqual(viewport.width + 0.5);
    expect(content.height * view.zoom).toBeLessThanOrEqual(viewport.height + 0.5);
    expect(view.scrollLeft).toBe(0);
    expect(view.scrollTop).toBe(0);
  });

  test("never magnifies a graph that already fits, and stops at the minimum", () => {
    expect(fitFlowView({ width: 400, height: 200 }, { width: 1440, height: 720 }).zoom).toBe(1);
    expect(fitFlowView({ width: 100_000, height: 200 }, { width: 1000, height: 720 }).zoom).toBe(
      FLOW_ZOOM_MIN,
    );
    expect(fitFlowView({ width: 0, height: 0 }, { width: 1000, height: 720 }).zoom).toBe(1);
  });

  test("fits the stacked column to the height the page shows it in", () => {
    expect(fitStackedFlowZoom(2_000, 800)).toBeCloseTo(0.4);
    expect(fitStackedFlowZoom(400, 800)).toBe(1);
    expect(fitStackedFlowZoom(40_000, 800)).toBe(FLOW_ZOOM_MIN);
    expect(fitStackedFlowZoom(2_000, null)).toBe(1);
    expect(fitStackedFlowZoom(0, 800)).toBe(1);
  });
});
