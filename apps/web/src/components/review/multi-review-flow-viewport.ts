/**
 * Zoom and pan for the Multi Review flow graph.
 *
 * The graph sits in a scrolling viewport: pan is the viewport's scroll
 * position, so wheel, trackpad and touch scrolling pan it natively and the
 * browser clamps it to the content. Zoom scales the canvas; content smaller
 * than the viewport is centred. Everything here is a pure function of the
 * zoom, the scroll position and the two sizes, so the component only applies
 * the answers.
 */

import { FLOW_GRAPH_MIN_HEIGHT, type FlowRect } from "./multi-review-flow";

export const FLOW_ZOOM_MIN = 0.2;
export const FLOW_ZOOM_MAX = 2;
/** What − and + step through. Fit can land between two steps. */
export const FLOW_ZOOM_STEPS: readonly number[] = [
  0.2, 0.25, 0.33, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 1.75, 2,
];
/**
 * The tallest the viewport grows. Eight reviewers fit at 100%; a larger panel
 * scrolls inside the viewport, and Fit shows all of it.
 */
export const FLOW_VIEWPORT_MAX_HEIGHT = 720;
/** Room kept between a node reached from the keyboard and the viewport edge. */
const KEEP_IN_VIEW_MARGIN = 24;
const ZOOM_EPSILON = 0.001;

export interface FlowSize {
  width: number;
  height: number;
}

export interface FlowView {
  zoom: number;
  scrollLeft: number;
  scrollTop: number;
}

export const DEFAULT_FLOW_VIEW: FlowView = { zoom: 1, scrollLeft: 0, scrollTop: 0 };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clampFlowZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return clamp(zoom, FLOW_ZOOM_MIN, FLOW_ZOOM_MAX);
}

/** The next step above (`1`) or below (`-1`) the current zoom. */
export function steppedFlowZoom(zoom: number, direction: 1 | -1): number {
  if (direction > 0) {
    return FLOW_ZOOM_STEPS.find((step) => step > zoom + ZOOM_EPSILON) ?? FLOW_ZOOM_MAX;
  }
  return [...FLOW_ZOOM_STEPS].reverse().find((step) => step < zoom - ZOOM_EPSILON) ?? FLOW_ZOOM_MIN;
}

export function canZoomIn(zoom: number): boolean {
  return zoom < FLOW_ZOOM_MAX - ZOOM_EPSILON;
}

export function canZoomOut(zoom: number): boolean {
  return zoom > FLOW_ZOOM_MIN + ZOOM_EPSILON;
}

/** The viewport keeps the graph's own height up to {@link FLOW_VIEWPORT_MAX_HEIGHT}. */
export function flowViewportHeight(contentHeight: number): number {
  return clamp(contentHeight, FLOW_GRAPH_MIN_HEIGHT, FLOW_VIEWPORT_MAX_HEIGHT);
}

/**
 * The zoom that shows the whole graph. It never magnifies: the layout already
 * fills the width at 100%, so Fit only ever zooms out.
 */
export function fitFlowZoom(content: FlowSize, viewport: FlowSize): number {
  if (content.width <= 0 || content.height <= 0) return 1;
  return clampFlowZoom(
    Math.min(1, viewport.width / content.width, viewport.height / content.height),
  );
}

/** Where the scaled canvas starts inside the viewport: centred when it is smaller. */
export function flowContentOffset(
  zoom: number,
  content: FlowSize,
  viewport: FlowSize,
): { x: number; y: number } {
  return {
    x: Math.max(0, Math.floor((viewport.width - content.width * zoom) / 2)),
    y: Math.max(0, Math.floor((viewport.height - content.height * zoom) / 2)),
  };
}

function clampScroll(view: FlowView, content: FlowSize, viewport: FlowSize): FlowView {
  const maxLeft = Math.max(0, Math.ceil(content.width * view.zoom - viewport.width));
  const maxTop = Math.max(0, Math.ceil(content.height * view.zoom - viewport.height));
  return {
    zoom: view.zoom,
    scrollLeft: Math.round(clamp(view.scrollLeft, 0, maxLeft)),
    scrollTop: Math.round(clamp(view.scrollTop, 0, maxTop)),
  };
}

/**
 * Zoom to `nextZoom`, keeping the canvas point under `anchor` (viewport
 * coordinates; the viewport centre when omitted) where it is.
 */
export function zoomFlowView(
  view: FlowView,
  nextZoom: number,
  content: FlowSize,
  viewport: FlowSize,
  anchor: { x: number; y: number } = { x: viewport.width / 2, y: viewport.height / 2 },
): FlowView {
  const zoom = clampFlowZoom(nextZoom);
  const before = flowContentOffset(view.zoom, content, viewport);
  const after = flowContentOffset(zoom, content, viewport);
  const canvasX = (view.scrollLeft + anchor.x - before.x) / view.zoom;
  const canvasY = (view.scrollTop + anchor.y - before.y) / view.zoom;
  return clampScroll(
    {
      zoom,
      scrollLeft: canvasX * zoom + after.x - anchor.x,
      scrollTop: canvasY * zoom + after.y - anchor.y,
    },
    content,
    viewport,
  );
}

/** Fit the whole graph; it is then centred, so nothing is scrolled. */
export function fitFlowView(content: FlowSize, viewport: FlowSize): FlowView {
  return { zoom: fitFlowZoom(content, viewport), scrollLeft: 0, scrollTop: 0 };
}

function revealAxis(
  scroll: number,
  start: number,
  end: number,
  extent: number,
  margin: number,
): number {
  // A node larger than the viewport shows its start.
  if (end - start + margin * 2 > extent) return start - margin;
  if (start - margin < scroll) return start - margin;
  if (end + margin > scroll + extent) return end + margin - extent;
  return scroll;
}

/**
 * The smallest scroll that brings `rect` (canvas coordinates) fully into view,
 * with a margin, so a node reached from the keyboard is never off screen.
 */
export function revealFlowRect(
  view: FlowView,
  rect: FlowRect,
  content: FlowSize,
  viewport: FlowSize,
  margin = KEEP_IN_VIEW_MARGIN,
): FlowView {
  const offset = flowContentOffset(view.zoom, content, viewport);
  const left = rect.x * view.zoom + offset.x;
  const top = rect.y * view.zoom + offset.y;
  return clampScroll(
    {
      zoom: view.zoom,
      scrollLeft: revealAxis(
        view.scrollLeft,
        left,
        left + rect.width * view.zoom,
        viewport.width,
        margin,
      ),
      scrollTop: revealAxis(
        view.scrollTop,
        top,
        top + rect.height * view.zoom,
        viewport.height,
        margin,
      ),
    },
    content,
    viewport,
  );
}

/**
 * The scroll that centres `rect` (canvas coordinates) across the viewport, as
 * far as the scroll range allows: at either end of the canvas the node sits
 * off centre rather than the canvas scrolling past its edge. Vertically it
 * only comes into view, as {@link revealFlowRect} brings it.
 */
export function centerFlowRect(
  view: FlowView,
  rect: FlowRect,
  content: FlowSize,
  viewport: FlowSize,
  margin = KEEP_IN_VIEW_MARGIN,
): FlowView {
  const offset = flowContentOffset(view.zoom, content, viewport);
  const left = rect.x * view.zoom + offset.x;
  const top = rect.y * view.zoom + offset.y;
  return clampScroll(
    {
      zoom: view.zoom,
      scrollLeft: left + (rect.width * view.zoom) / 2 - viewport.width / 2,
      scrollTop: revealAxis(
        view.scrollTop,
        top,
        top + rect.height * view.zoom,
        viewport.height,
        margin,
      ),
    },
    content,
    viewport,
  );
}

/**
 * The zoom factor for one wheel or pinch event. Chromium reports a trackpad
 * pinch as a wheel event with `ctrlKey` and small deltas; a mouse wheel notch
 * is much larger, so each event is capped to keep a notch to one gentle step.
 */
export function wheelZoomFactor(deltaY: number, deltaMode: number): number {
  const unit = deltaMode === 1 ? 0.05 : deltaMode === 2 ? 1 : 0.002;
  const exponent = clamp(-deltaY * unit * 10, -0.5, 0.5);
  return 2 ** exponent;
}

/**
 * The zoom a two-finger pinch asks for: the zoom it started at, scaled by how
 * far the fingers have spread since, within the zoom bounds.
 */
export function pinchFlowZoom(startZoom: number, startDistance: number, distance: number): number {
  if (!(startDistance > 0) || !Number.isFinite(distance)) return clampFlowZoom(startZoom);
  return clampFlowZoom((startZoom * distance) / startDistance);
}

/**
 * The stacked layout's Fit: the whole column within the height the page shows
 * it in. It never magnifies, and a height that could not be measured leaves
 * the column at 100%.
 */
export function fitStackedFlowZoom(contentHeight: number, availableHeight: number | null): number {
  if (!(contentHeight > 0) || availableHeight === null || !(availableHeight > 0)) return 1;
  return clampFlowZoom(Math.min(1, availableHeight / contentHeight));
}
