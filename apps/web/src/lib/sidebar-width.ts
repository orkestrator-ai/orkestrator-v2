/**
 * The desktop sidebar panel's widths, and when a change of width may animate.
 * Pure; `useSidebarPanelMotion` applies them.
 */

/** One large icon (`CommandNodeHomeIcon` and its activity ring) with even margins. */
export const COMPACT_SIDEBAR_WIDTH_PX = 56;
export const SIDEBAR_MIN_WIDTH_PX = 280;
export const SIDEBAR_MAX_WIDTH_PX = 400;
export const SIDEBAR_WIDTH_TRANSITION_MS = 180;

export type SidebarPanelMode = "full" | "compact" | "hidden";

export function sidebarPanelMode(input: {
  sidebarOpen: boolean;
  compact: boolean;
}): SidebarPanelMode {
  if (!input.sidebarOpen) return "hidden";
  return input.compact ? "compact" : "full";
}

/** The panel's size limits. Compact and hidden fix the width, so nothing can drag it. */
export function sidebarPanelConstraints(mode: SidebarPanelMode): {
  minSize: string;
  maxSize: string;
} {
  switch (mode) {
    case "full":
      return { minSize: `${SIDEBAR_MIN_WIDTH_PX}px`, maxSize: `${SIDEBAR_MAX_WIDTH_PX}px` };
    case "compact":
      return { minSize: `${COMPACT_SIDEBAR_WIDTH_PX}px`, maxSize: `${COMPACT_SIDEBAR_WIDTH_PX}px` };
    case "hidden":
      return { minSize: "0px", maxSize: "0px" };
  }
}

export function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH_PX, Math.max(SIDEBAR_MIN_WIDTH_PX, width));
}

/** The width `mode` settles on; `remembered` is the width a full sidebar returns to. */
export function sidebarPanelWidth(mode: SidebarPanelMode, remembered: number): number {
  if (mode === "hidden") return 0;
  return mode === "compact" ? COMPACT_SIDEBAR_WIDTH_PX : clampSidebarWidth(remembered);
}

/**
 * The width to remember on leaving the full sidebar. A measurement outside its
 * limits is not the user's width: the panel was already on its way elsewhere.
 */
export function rememberedSidebarWidth(current: number, measured: number | null): number {
  return measured !== null && measured >= SIDEBAR_MIN_WIDTH_PX && measured <= SIDEBAR_MAX_WIDTH_PX
    ? measured
    : current;
}

/** A width follows the pointer while it is dragged, and never moves on its own under reduced motion. */
export function shouldAnimateSidebarWidth(input: {
  reducedMotion: boolean;
  dragging: boolean;
}): boolean {
  return !input.reducedMotion && !input.dragging;
}

/**
 * The widths to hold the sidebar's and the main column's content at while the
 * panels between them animate: the larger of the start and end width. Content
 * held there is clipped by its panel rather than laid out again on every frame,
 * so a terminal or editor is resized once, not once per frame.
 */
export function sidebarMotionPins(input: {
  sidebarFrom: number;
  sidebarTo: number;
  mainFrom: number;
}): { sidebar: number; main: number } {
  return {
    sidebar: Math.max(input.sidebarFrom, input.sidebarTo),
    main: Math.max(input.mainFrom, input.mainFrom + input.sidebarFrom - input.sidebarTo),
  };
}
