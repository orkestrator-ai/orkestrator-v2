/**
 * Frame space ↔ viewport space. A point p in canvas coordinates appears at
 * `p * zoom + pan` inside the viewport element (CSS pixels, origin top-left).
 */
export interface DesignViewport {
  panX: number;
  panY: number;
  zoom: number;
}
export interface Point {
  x: number;
  y: number;
}
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Size {
  width: number;
  height: number;
}

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 4;
export const DEFAULT_VIEWPORT: DesignViewport = { panX: 45, panY: 65, zoom: 0.65 };
/** Frame chrome drawn outside the frame box: name label above, resize handle below-right. */
export const FRAME_CHROME = { top: 32, right: 12, bottom: 12, left: 4 };

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return DEFAULT_VIEWPORT.zoom;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function toScreen(viewport: DesignViewport, point: Point): Point {
  return { x: point.x * viewport.zoom + viewport.panX, y: point.y * viewport.zoom + viewport.panY };
}

export function toCanvas(viewport: DesignViewport, point: Point): Point {
  return {
    x: (point.x - viewport.panX) / viewport.zoom,
    y: (point.y - viewport.panY) / viewport.zoom,
  };
}

/** Zooms so the canvas point under `anchor` stays under `anchor`. */
export function zoomAt(viewport: DesignViewport, anchor: Point, nextZoom: number): DesignViewport {
  const zoom = clampZoom(nextZoom);
  const fixed = toCanvas(viewport, anchor);
  return { zoom, panX: anchor.x - fixed.x * zoom, panY: anchor.y - fixed.y * zoom };
}

export function boundsOf(rects: Rect[], chrome = FRAME_CHROME): Rect | null {
  if (!rects.length) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const rect of rects) {
    left = Math.min(left, rect.x - chrome.left);
    top = Math.min(top, rect.y - chrome.top);
    right = Math.max(right, rect.x + rect.width + chrome.right);
    bottom = Math.max(bottom, rect.y + rect.height + chrome.bottom);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Viewport that shows `bounds` centered with padding, clamped to supported zoom. */
export function fitBounds(
  bounds: Rect | null,
  size: Size,
  options: { padding?: number; maxZoom?: number } = {},
): DesignViewport {
  if (!bounds || size.width <= 0 || size.height <= 0) return DEFAULT_VIEWPORT;
  const padding = options.padding ?? 48;
  const availableWidth = Math.max(1, size.width - padding * 2);
  const availableHeight = Math.max(1, size.height - padding * 2);
  const zoom = clampZoom(
    Math.min(
      options.maxZoom ?? 2,
      availableWidth / Math.max(1, bounds.width),
      availableHeight / Math.max(1, bounds.height),
    ),
  );
  return {
    zoom,
    panX: size.width / 2 - (bounds.x + bounds.width / 2) * zoom,
    panY: size.height / 2 - (bounds.y + bounds.height / 2) * zoom,
  };
}

/** Centers `point` at the given zoom (100% view of a selection). */
export function centerOn(point: Point, size: Size, zoom: number): DesignViewport {
  const next = clampZoom(zoom);
  return {
    zoom: next,
    panX: size.width / 2 - point.x * next,
    panY: size.height / 2 - point.y * next,
  };
}

export interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/**
 * Pixel deltas for all wheel modes. Ctrl/⌘ (including trackpad pinch, which
 * browsers report as ctrlKey) zooms; Shift turns vertical wheel into horizontal pan.
 */
export function wheelAction(
  event: WheelLike,
): { kind: "zoom"; factor: number } | { kind: "pan"; dx: number; dy: number } {
  const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
  const dx = event.deltaX * scale;
  const dy = event.deltaY * scale;
  if (event.ctrlKey || event.metaKey) {
    const magnitude = Math.max(-200, Math.min(200, dy));
    return { kind: "zoom", factor: Math.exp(-magnitude * 0.002) };
  }
  if (event.shiftKey && dx === 0) return { kind: "pan", dx: dy, dy: 0 };
  return { kind: "pan", dx, dy };
}

export function visibleCanvasRect(viewport: DesignViewport, size: Size, overscan = 0): Rect {
  const topLeft = toCanvas(viewport, { x: -size.width * overscan, y: -size.height * overscan });
  const bottomRight = toCanvas(viewport, {
    x: size.width * (1 + overscan),
    y: size.height * (1 + overscan),
  });
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: bottomRight.x - topLeft.x,
    height: bottomRight.y - topLeft.y,
  };
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Validates a restored view against current frames; unusable values reset to fit. */
export function restoreViewport(
  saved: DesignViewport | undefined,
  frames: Rect[],
  size: Size,
): DesignViewport {
  if (
    !saved ||
    !Number.isFinite(saved.panX) ||
    !Number.isFinite(saved.panY) ||
    !Number.isFinite(saved.zoom) ||
    Math.abs(saved.panX) > 10_000_000 ||
    Math.abs(saved.panY) > 10_000_000
  )
    return frames.length ? fitBounds(boundsOf(frames), size, { maxZoom: 1 }) : DEFAULT_VIEWPORT;
  const viewport = { ...saved, zoom: clampZoom(saved.zoom) };
  const bounds = boundsOf(frames);
  if (bounds && size.width > 0 && !intersects(visibleCanvasRect(viewport, size), bounds))
    return fitBounds(bounds, size, { maxZoom: 1 });
  return viewport;
}

export const FRAME_PRESETS: Array<{ label: string; width: number; height: number }> = [
  { label: "Desktop 1440", width: 1440, height: 900 },
  { label: "Laptop 1280", width: 1280, height: 800 },
  { label: "Tablet 834", width: 834, height: 1112 },
  { label: "Mobile 390", width: 390, height: 844 },
  { label: "Mobile 360", width: 360, height: 800 },
];

export function clampDimension(value: number): number {
  if (!Number.isFinite(value)) return 32;
  return Math.max(32, Math.min(4096, Math.round(value)));
}

export function clampCoordinate(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-100_000, Math.min(100_000, Math.round(value)));
}
