/**
 * Snapping for frame gestures on the design canvas: a world-space grid, edge
 * alignment with the other frames (drawn as red guides), and the marquee
 * hit-test. Pure geometry in canvas coordinates; the canvas owns the state.
 */
import type { Point, Rect } from "./design-viewport";

/** Snap pitch in canvas pixels. Every displayed grid step is a multiple of it. */
export const DESIGN_GRID_SIZE = 10;
/** How close (in screen pixels) an edge must come to another frame's edge to snap. */
export const SNAP_THRESHOLD_PX = 6;
/** Pointer travel (screen pixels) before a Shift-press becomes a marquee. */
export const MARQUEE_START_PX = 3;
/** Smallest on-screen spacing between displayed grid dots or lines. */
const MIN_GRID_SCREEN_PX = 12;
const GRID_MULTIPLES = [1, 2, 5];

/**
 * A guide line between aligned frames, in canvas coordinates. `axis: "y"` is a
 * horizontal line at `y = position` running from `start` to `end` along x;
 * `axis: "x"` is a vertical line at `x = position` running along y.
 */
export interface SnapGuide {
  axis: "x" | "y";
  position: number;
  start: number;
  end: number;
}

export interface SnapResult {
  rect: Rect;
  guides: SnapGuide[];
}

/** The displayed grid step for a zoom: the snap pitch times 1, 2, 5, 10, 20, 50… */
export function gridStep(zoom: number, grid = DESIGN_GRID_SIZE): number {
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  for (let magnitude = 1; magnitude <= 1e6; magnitude *= 10) {
    for (const multiple of GRID_MULTIPLES) {
      const step = grid * multiple * magnitude;
      if (step * scale >= MIN_GRID_SCREEN_PX) return step;
    }
  }
  return grid * 1e6;
}

export function snapToGrid(value: number, grid = DESIGN_GRID_SIZE): number {
  return Math.round(value / grid) * grid;
}

/** Edge positions along one axis: start, end. */
function edges(rect: Rect, axis: "x" | "y"): [number, number] {
  return axis === "x" ? [rect.x, rect.x + rect.width] : [rect.y, rect.y + rect.height];
}

/**
 * The smallest shift that puts one of `moving` on one of the other frames'
 * edges along `axis`, or null when none is within `threshold`.
 */
function nearestAlignment(
  moving: readonly number[],
  others: readonly Rect[],
  axis: "x" | "y",
  threshold: number,
): number | null {
  let best: number | null = null;
  for (const other of others) {
    for (const target of edges(other, axis)) {
      for (const edge of moving) {
        const delta = target - edge;
        if (Math.abs(delta) <= threshold && (best === null || Math.abs(delta) < Math.abs(best)))
          best = delta;
      }
    }
  }
  return best;
}

const ALIGNED_EPSILON = 0.5;

/**
 * Guides for every edge of `rect` that lies exactly on an edge of another
 * frame. A frame that shares both its top and bottom with a neighbour (the
 * same height, side by side) gets two lines; each line runs between the two
 * frames so the pair reads as matched.
 */
export function alignmentGuides(rect: Rect, others: readonly Rect[]): SnapGuide[] {
  const guides: SnapGuide[] = [];
  const seen = new Set<string>();
  for (const axis of ["y", "x"] as const) {
    const cross = axis === "y" ? "x" : "y";
    const [start, end] = edges(rect, cross);
    for (const edge of edges(rect, axis)) {
      for (const other of others) {
        if (!edges(other, axis).some((target) => Math.abs(target - edge) < ALIGNED_EPSILON))
          continue;
        const [otherStart, otherEnd] = edges(other, cross);
        const guide: SnapGuide = {
          axis,
          position: edge,
          start: Math.min(start, otherStart),
          end: Math.max(end, otherEnd),
        };
        const key = `${axis}:${guide.position}:${guide.start}:${guide.end}`;
        if (seen.has(key)) continue;
        seen.add(key);
        guides.push(guide);
      }
    }
  }
  return guides;
}

export interface SnapOptions {
  /** Snap pitch in canvas pixels. */
  grid?: number;
  /** Alignment reach in canvas pixels (screen threshold divided by zoom). */
  threshold: number;
}

/**
 * Snaps a moving rectangle (one frame, or the bounds of several moved
 * together). On each axis an edge within `threshold` of another frame's edge
 * wins; otherwise the top-left corner lands on the grid.
 */
export function snapMove(rect: Rect, others: readonly Rect[], options: SnapOptions): SnapResult {
  const grid = options.grid ?? DESIGN_GRID_SIZE;
  const shiftAxis = (axis: "x" | "y") => {
    const position = axis === "x" ? rect.x : rect.y;
    const aligned = nearestAlignment(edges(rect, axis), others, axis, options.threshold);
    return aligned ?? snapToGrid(position, grid) - position;
  };
  const snapped = { ...rect, x: rect.x + shiftAxis("x"), y: rect.y + shiftAxis("y") };
  return { rect: snapped, guides: alignmentGuides(snapped, others) };
}

/**
 * Snaps the right and bottom edges of a frame being resized from its
 * bottom-right corner: to another frame's edge when one is in reach, else to
 * the grid. The size never drops below `minSize`.
 */
export function snapResize(
  rect: Rect,
  others: readonly Rect[],
  options: SnapOptions & { minSize?: number },
): SnapResult {
  const grid = options.grid ?? DESIGN_GRID_SIZE;
  const minSize = options.minSize ?? 0;
  const snapEdge = (axis: "x" | "y") => {
    const origin = axis === "x" ? rect.x : rect.y;
    const edge = origin + (axis === "x" ? rect.width : rect.height);
    const aligned = nearestAlignment([edge], others, axis, options.threshold);
    let target = aligned === null ? snapToGrid(edge, grid) : edge + aligned;
    if (target - origin < minSize) target = origin + minSize;
    return target - origin;
  };
  const snapped = { ...rect, width: snapEdge("x"), height: snapEdge("y") };
  return { rect: snapped, guides: alignmentGuides(snapped, others) };
}

/** The rectangle spanned by two corners, whichever way it was dragged. */
export function rectFromPoints(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height
  );
}

/** Ids of the frames a marquee touches, in canvas order. */
export function framesInMarquee<T extends Rect & { id: string }>(
  marquee: Rect,
  frames: readonly T[],
): string[] {
  return frames.filter((frame) => rectsIntersect(marquee, frame)).map((frame) => frame.id);
}

/** Bounding box of several rectangles; null for none. */
export function unionRect(rects: readonly Rect[]): Rect | null {
  if (!rects.length) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const rect of rects) {
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.width);
    bottom = Math.max(bottom, rect.y + rect.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}
