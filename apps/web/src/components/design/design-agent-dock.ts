import type { DesignAgentDock } from "@/types/paneLayout";
import { clampDesignAgentPanelSize, isHorizontalDock } from "@/stores/pane-layout-embedded";

/**
 * Pure geometry for the design tab's agent panel, kept apart from the
 * component so the drag and resize rules are unit-testable.
 */

export interface DockRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The edge nearest a pointer inside the design tab: where a dragged panel docks. */
export function dockFromPointer(rect: DockRect, clientX: number, clientY: number): DesignAgentDock {
  if (rect.width <= 0 || rect.height <= 0) return "left";
  const x = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  const y = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
  const distances: Array<[DesignAgentDock, number]> = [
    ["left", x],
    ["right", 1 - x],
    ["top", y],
    ["bottom", 1 - y],
  ];
  let nearest = distances[0]!;
  for (const candidate of distances) if (candidate[1] < nearest[1]) nearest = candidate;
  return nearest[0];
}

/** Arrow keys on the move handle dock the panel to that edge. */
export function dockFromArrowKey(key: string): DesignAgentDock | null {
  switch (key) {
    case "ArrowLeft":
      return "left";
    case "ArrowRight":
      return "right";
    case "ArrowUp":
      return "top";
    case "ArrowDown":
      return "bottom";
    default:
      return null;
  }
}

/** True when the panel comes before the canvas in reading order. */
export function panelLeads(dock: DesignAgentDock): boolean {
  return dock === "left" || dock === "top";
}

/**
 * The panel size after dragging its separator by `deltaPx` (pointer movement
 * along the dock axis). Dragging toward the canvas grows the panel.
 */
export function resizedPanelSize(options: {
  dock: DesignAgentDock;
  startSize: number;
  deltaPx: number;
  containerPx: number;
}): number {
  const { dock, startSize, deltaPx, containerPx } = options;
  if (containerPx <= 0) return clampDesignAgentPanelSize(startSize);
  const signed = panelLeads(dock) ? deltaPx : -deltaPx;
  return clampDesignAgentPanelSize(startSize + (signed / containerPx) * 100);
}

/** Separator keys: arrows step 2%, Home and End jump to the bounds. */
export function keyboardPanelSize(dock: DesignAgentDock, size: number, key: string): number | null {
  const horizontal = isHorizontalDock(dock);
  const grow = panelLeads(dock)
    ? horizontal
      ? "ArrowRight"
      : "ArrowDown"
    : horizontal
      ? "ArrowLeft"
      : "ArrowUp";
  const shrink = panelLeads(dock)
    ? horizontal
      ? "ArrowLeft"
      : "ArrowUp"
    : horizontal
      ? "ArrowRight"
      : "ArrowDown";
  if (key === grow) return clampDesignAgentPanelSize(size + 2);
  if (key === shrink) return clampDesignAgentPanelSize(size - 2);
  if (key === "Home") return clampDesignAgentPanelSize(0);
  if (key === "End") return clampDesignAgentPanelSize(100);
  return null;
}

/** Ctrl/⌘+. shows or hides the agent panel. */
export function isAgentPanelShortcut(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): boolean {
  return event.key === "." && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
}
