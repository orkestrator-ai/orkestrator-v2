/** Canvas documents are backend owned; pane layouts contain only their id. */
export const DESIGN_EVENT = "design-canvas-changed";
export const DESIGN_CONFLICT = "Design revision conflict:";
export const DESIGN_MAX_HTML_BYTES = 256 * 1024;
export const DESIGN_MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
export const DESIGN_MAX_FRAMES = 64;
export const DESIGN_HISTORY_LIMIT = 10;
export const DESIGN_HISTORY_MAX_BYTES = 16 * 1024 * 1024;
export interface DesignFrame {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  html: string;
  revision: number;
}
export interface DesignCanvas {
  format: "orkdes";
  version: 1;
  id: string;
  environmentId: string;
  name: string;
  revision: number;
  frames: DesignFrame[];
}
export interface DesignChange {
  canvasId: string;
  revision: number;
  frameId?: string;
}
export interface DesignChanges {
  generation: string;
  revision: number;
  reset: boolean;
  events: DesignChange[];
}
export interface DesignHistoryStatus {
  revision: number;
  undoCount: number;
  redoCount: number;
  canUndo: boolean;
  canRedo: boolean;
}
export interface DesignCanvasState {
  canvas: DesignCanvas;
  history: DesignHistoryStatus;
}
export interface DesignElement {
  selector: string;
  tag: string;
  text: string;
  attributes: Record<string, string>;
  styles: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
}
export interface DesignLayer {
  selector: string;
  tag: string;
  label: string;
  depth: number;
}
export type DesignOperation =
  | { op: "render"; html: string }
  | { op: "hitTest"; x: number; y: number }
  | { op: "inspectElement"; selector: string }
  | { op: "setStyles"; selector: string; styles: Record<string, string | null> }
  | { op: "replaceElementHtml"; selector: string; html: string }
  | { op: "appendHtml"; html: string }
  | { op: "moveElement"; selector: string; parentSelector: string; beforeSelector?: string }
  | { op: "serialize" }
  | { op: "hierarchy" };
