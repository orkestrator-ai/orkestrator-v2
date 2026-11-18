/**
 * Advisory region diffs between an annotation's original capture and a
 * result (after) capture (`operations.resultDiffs`; from to-do 0047 (retired) task 2).
 *
 * A diff is evidence for a reviewer, never a verdict: it marks the regions
 * whose pixels changed and says how much of the compared area that is. It is
 * computed only for captures taken under the same conditions (route, service,
 * viewport, scroll, zoom, device scale and stored image size), with every
 * redaction mask and every region the desktop saw moving on its own (the
 * unstable-region mask) left out. Anything else is refused with a reason
 * rather than resized or guessed at, because a resized comparison would
 * report layout changes that are only scaling.
 *
 * `compareWebAnnotationRasters` is the one pixel comparison: the backend runs
 * it on decoded stored images, and the desktop runs it on two samples of the
 * same page to find the regions that move without any change (the unstable
 * mask). Pure and browser-safe.
 */
import type { WebAnnotationRect } from "./web-annotations.js";

export const WEB_ANNOTATION_DIFF_LIMITS = Object.freeze({
  /** Largest decoded image either side may have (the stored image ceiling, 2000 × 2000). */
  maxPixels: 4_000_000,
  /** Whole diff, decode included. */
  timeoutMs: 5_000,
  /** Diffs one backend runs at once; more are refused as busy, never queued. */
  maxConcurrent: 2,
  /** Regions returned; the counts always cover every change. */
  maxRegions: 32,
  /** Unstable regions a result capture may carry. */
  unstableRegions: 32,
  /** Grid cell, in pixels of the compared images, that regions are built from. */
  cellPixels: 8,
  /** Largest per-channel difference still treated as the same pixel (encoder and font noise). */
  channelTolerance: 24,
  /** Changed pixels a cell needs before it counts, so single-pixel noise marks nothing. */
  minCellPixels: 2,
  /** Grid cell, in CSS pixels, the desktop uses to build the unstable-region mask. */
  unstableCellCssPixels: 16,
  /** Scroll offsets further apart than this (CSS pixels) show different content. */
  scrollTolerance: 1,
} as const);

/** Why a diff was not computed. Each code has a fixed message (`WEB_ANNOTATION_DIFF_REFUSALS`). */
export type WebAnnotationResultDiffRefusal =
  | "not-result-capture"
  | "original-unavailable"
  | "no-image"
  | "image-excluded"
  | "stale"
  | "route"
  | "service"
  | "unknown-page"
  | "viewport"
  | "scroll"
  | "zoom"
  | "device-scale"
  | "image-size"
  | "unstable"
  | "no-unstable-mask"
  | "missing-redaction-masks"
  | "nothing-comparable"
  | "too-large"
  | "decode-failed"
  | "timeout"
  | "busy";

/** Content-free, fixed explanations shown to the user and the agent. */
export const WEB_ANNOTATION_DIFF_REFUSALS: Readonly<
  Record<WebAnnotationResultDiffRefusal, string>
> = Object.freeze({
  "not-result-capture": "This capture is not an after-capture of a request result.",
  "original-unavailable": "The original capture it is compared with is no longer readable.",
  "no-image": "One of the captures has no stored image.",
  "image-excluded": "One of the captures kept text evidence only, so it has no image to compare.",
  stale: "One of the captures is stale: the page changed while it was taken.",
  route: "The captures show different pages.",
  service: "The captures come from different preview services.",
  "unknown-page": "The page identity could not be verified for one of the captures.",
  viewport: "The captures were taken at different viewport sizes.",
  scroll: "The captures were taken at different scroll positions.",
  zoom: "The captures were taken at different zoom levels.",
  "device-scale": "The captures were taken at different device pixel ratios.",
  "image-size": "The stored images have different sizes; they are never resized to fit.",
  unstable: "The page had not settled when the after-capture was taken.",
  "no-unstable-mask":
    "The after-capture has no verified motion mask. Capture the result again to sample for movement.",
  "missing-redaction-masks":
    "The redaction locations are incomplete. Capture the affected image again to compare it.",
  "nothing-comparable": "Masks and moving regions cover the whole image; nothing was compared.",
  "too-large": "The images are larger than the diff may decode.",
  "decode-failed": "A stored image could not be decoded.",
  timeout: "The diff took too long and was stopped.",
  busy: "Other diffs are running; try again shortly.",
});

/** A changed region, in pixels of the stored images and in CSS pixels of the viewport. */
export interface WebAnnotationResultDiffRegion {
  rect: WebAnnotationRect;
  cssRect: WebAnnotationRect;
  changedPixels: number;
}

interface WebAnnotationResultDiffBase {
  /** Always true: a diff is evidence for review, never a pass, fail or resolution. */
  advisory: true;
  beforeCaptureId: string | null;
  afterCaptureId: string;
}

export interface WebAnnotationResultDiffCompared extends WebAnnotationResultDiffBase {
  status: "compared";
  /** Size of both stored images. */
  image: { width: number; height: number };
  /** CSS → image scale of both captures. */
  scale: number;
  changedPixels: number;
  /** Pixels compared (the image minus excluded pixels). */
  comparedPixels: number;
  /** Pixels left out: redaction masks and unstable regions. */
  excludedPixels: number;
  /** `changedPixels / comparedPixels`, rounded to four places. */
  changedRatio: number;
  /** Largest changes first in count; listed top to bottom. */
  regions: WebAnnotationResultDiffRegion[];
  /** More regions changed than `maxRegions`; the counts still cover all of them. */
  truncatedRegions: boolean;
  excluded: { masks: number; unstableRegions: number };
  tolerance: number;
}

export interface WebAnnotationResultDiffIncomparable extends WebAnnotationResultDiffBase {
  status: "incomparable";
  /** Every reason found, in a fixed order, each with its fixed message. */
  reasons: Array<{ code: WebAnnotationResultDiffRefusal; message: string }>;
}

export type WebAnnotationResultDiff =
  WebAnnotationResultDiffCompared | WebAnnotationResultDiffIncomparable;

export function webAnnotationDiffRefusal(code: WebAnnotationResultDiffRefusal): {
  code: WebAnnotationResultDiffRefusal;
  message: string;
} {
  return { code, message: WEB_ANNOTATION_DIFF_REFUSALS[code] };
}

/** One decoded image: `channels` interleaved bytes per pixel, row by row. */
export interface WebAnnotationRaster {
  width: number;
  height: number;
  channels: number;
  data: Uint8Array;
}

export interface WebAnnotationRasterCompareOptions {
  /** Rectangles in raster pixels that are never compared. */
  excluded?: readonly WebAnnotationRect[];
  cellPixels?: number;
  tolerance?: number;
  minCellPixels?: number;
  maxRegions?: number;
  /** `now()` value after which the comparison stops and reports `timedOut`. */
  deadline?: number;
  now?: () => number;
}

export type WebAnnotationRasterComparison =
  | { timedOut: true }
  | {
      timedOut: false;
      changedPixels: number;
      comparedPixels: number;
      excludedPixels: number;
      regions: Array<{ rect: WebAnnotationRect; changedPixels: number }>;
      truncatedRegions: boolean;
      /** Bounding box of every changed cell, or null when nothing changed. */
      bounds: WebAnnotationRect | null;
    };

const DEADLINE_CHECK_ROWS = 32;

function exclusionMask(
  width: number,
  height: number,
  rects: readonly WebAnnotationRect[],
): Uint8Array | null {
  if (rects.length === 0) return null;
  const mask = new Uint8Array(width * height);
  for (const rect of rects) {
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) continue;
    // Rounded outward: a mask edge never leaves a sliver of redaction compared.
    const x0 = Math.max(0, Math.floor(rect.x));
    const y0 = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(width, Math.ceil(rect.x + rect.width));
    const y1 = Math.min(height, Math.ceil(rect.y + rect.height));
    if (x1 <= x0 || y1 <= y0) continue;
    for (let y = y0; y < y1; y += 1) mask.fill(1, y * width + x0, y * width + x1);
  }
  return mask;
}

/**
 * Compare two rasters of the same size and layout. A pixel changed when any
 * channel differs by more than `tolerance`; changed pixels are counted per
 * grid cell, and touching cells (diagonals included) become one region.
 * Throws on rasters that do not match, which callers check first.
 */
export function compareWebAnnotationRasters(
  before: WebAnnotationRaster,
  after: WebAnnotationRaster,
  options: WebAnnotationRasterCompareOptions = {},
): WebAnnotationRasterComparison {
  const { width, height, channels } = before;
  if (
    after.width !== width ||
    after.height !== height ||
    after.channels !== channels ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    channels < 1 ||
    channels > 4 ||
    before.data.length < width * height * channels ||
    after.data.length < width * height * channels
  ) {
    throw new Error("Rasters to compare must have the same size and layout");
  }
  const cell = Math.max(1, Math.round(options.cellPixels ?? WEB_ANNOTATION_DIFF_LIMITS.cellPixels));
  const tolerance = options.tolerance ?? WEB_ANNOTATION_DIFF_LIMITS.channelTolerance;
  const minCellPixels = Math.max(
    1,
    options.minCellPixels ?? WEB_ANNOTATION_DIFF_LIMITS.minCellPixels,
  );
  const maxRegions = Math.max(1, options.maxRegions ?? WEB_ANNOTATION_DIFF_LIMITS.maxRegions);
  const now = options.now ?? Date.now;
  const expired = () => options.deadline !== undefined && now() >= options.deadline;
  const mask = exclusionMask(width, height, options.excluded ?? []);
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const cellCounts = new Uint32Array(cols * rows);
  const a = before.data;
  const b = after.data;
  let changedPixels = 0;
  let excludedPixels = 0;

  for (let y = 0; y < height; y += 1) {
    if (y % DEADLINE_CHECK_ROWS === 0 && expired()) return { timedOut: true };
    const rowCell = Math.floor(y / cell) * cols;
    let offset = y * width * channels;
    for (let x = 0; x < width; x += 1, offset += channels) {
      if (mask && mask[y * width + x] === 1) {
        excludedPixels += 1;
        continue;
      }
      let changed = false;
      for (let channel = 0; channel < channels; channel += 1) {
        const delta = a[offset + channel]! - b[offset + channel]!;
        if (delta > tolerance || delta < -tolerance) {
          changed = true;
          break;
        }
      }
      if (changed) {
        changedPixels += 1;
        cellCounts[rowCell + Math.floor(x / cell)]! += 1;
      }
    }
  }

  if (expired()) return { timedOut: true };
  const visited = new Uint8Array(cols * rows);
  const components: Array<{ rect: WebAnnotationRect; changedPixels: number }> = [];
  let bounds: { x0: number; y0: number; x1: number; y1: number } | null = null;
  const stack: number[] = [];
  let visitedCount = 0;
  const checkCells = 1_024;
  for (let start = 0; start < cellCounts.length; start += 1) {
    if (start % checkCells === 0 && expired()) return { timedOut: true };
    if (visited[start] === 1 || cellCounts[start]! < minCellPixels) continue;
    visited[start] = 1;
    stack.push(start);
    let cx0 = cols;
    let cy0 = rows;
    let cx1 = -1;
    let cy1 = -1;
    let count = 0;
    while (stack.length > 0) {
      if (++visitedCount % checkCells === 0 && expired()) return { timedOut: true };
      const index = stack.pop()!;
      const cx = index % cols;
      const cy = (index - cx) / cols;
      count += cellCounts[index]!;
      if (cx < cx0) cx0 = cx;
      if (cy < cy0) cy0 = cy;
      if (cx > cx1) cx1 = cx;
      if (cy > cy1) cy1 = cy;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = cy + dy;
        if (ny < 0 || ny >= rows) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = cx + dx;
          if (nx < 0 || nx >= cols || (dx === 0 && dy === 0)) continue;
          const next = ny * cols + nx;
          if (visited[next] === 1 || cellCounts[next]! < minCellPixels) continue;
          visited[next] = 1;
          stack.push(next);
        }
      }
    }
    const x0 = cx0 * cell;
    const y0 = cy0 * cell;
    const x1 = Math.min(width, (cx1 + 1) * cell);
    const y1 = Math.min(height, (cy1 + 1) * cell);
    components.push({
      rect: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
      changedPixels: count,
    });
    bounds = bounds
      ? {
          x0: Math.min(bounds.x0, x0),
          y0: Math.min(bounds.y0, y0),
          x1: Math.max(bounds.x1, x1),
          y1: Math.max(bounds.y1, y1),
        }
      : { x0, y0, x1, y1 };
  }
  components.sort((left, right) => right.changedPixels - left.changedPixels);
  const regions = components
    .slice(0, maxRegions)
    .sort((left, right) => left.rect.y - right.rect.y || left.rect.x - right.rect.x);
  if (expired()) return { timedOut: true };
  return {
    timedOut: false,
    changedPixels,
    comparedPixels: width * height - excludedPixels,
    excludedPixels,
    regions,
    truncatedRegions: components.length > maxRegions,
    bounds: bounds
      ? { x: bounds.x0, y: bounds.y0, width: bounds.x1 - bounds.x0, height: bounds.y1 - bounds.y0 }
      : null,
  };
}
