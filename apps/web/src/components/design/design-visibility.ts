import {
  intersects,
  visibleCanvasRect,
  type DesignViewport,
  type Rect,
  type Size,
} from "./design-viewport";

export const LIVE_FRAME_BUDGET = 8;
export const OVERSCAN = 0.25;
/** Below this on-screen size a frame shows a placeholder unless it is pinned. */
export const MIN_LIVE_SCREEN_PX = 48;

export interface VisibilityInput {
  frames: Array<Rect & { id: string }>;
  viewport: DesignViewport;
  size: Size;
  budget?: number;
  overscan?: number;
  /** Frames with an active gesture or edit: never culled mid-interaction. */
  pinned?: ReadonlySet<string>;
  selected?: string | null;
  focused?: string | null;
}

export interface VisibilityPlan {
  /** Frames that get a live iframe. */
  live: Set<string>;
  /** Frames intersecting the viewport plus overscan. */
  visible: Set<string>;
}

/**
 * Chooses which frames receive a live preview: pinned first, then the
 * selected/focused frame, then visible frames nearest the viewport center.
 * Offscreen frames keep no DOM authority; the backend stays authoritative.
 */
export function planLiveFrames(input: VisibilityInput): VisibilityPlan {
  const budget = Math.max(1, input.budget ?? LIVE_FRAME_BUDGET);
  const area = visibleCanvasRect(input.viewport, input.size, input.overscan ?? OVERSCAN);
  const center = { x: area.x + area.width / 2, y: area.y + area.height / 2 };
  const visible = new Set<string>();
  const candidates: Array<{ id: string; distance: number }> = [];
  for (const frame of input.frames) {
    if (!intersects(frame, area)) continue;
    visible.add(frame.id);
    const onScreen = Math.max(frame.width, frame.height) * input.viewport.zoom;
    if (onScreen < MIN_LIVE_SCREEN_PX) continue;
    const dx = frame.x + frame.width / 2 - center.x;
    const dy = frame.y + frame.height / 2 - center.y;
    candidates.push({ id: frame.id, distance: dx * dx + dy * dy });
  }
  const live = new Set<string>();
  const ids = new Set(input.frames.map((frame) => frame.id));
  for (const id of input.pinned ?? []) if (ids.has(id)) live.add(id);
  for (const id of [input.selected, input.focused]) {
    if (id && ids.has(id) && visible.has(id) && live.size < budget) live.add(id);
  }
  candidates.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
  for (const candidate of candidates) {
    if (live.size >= budget) break;
    live.add(candidate.id);
  }
  return { live, visible };
}
