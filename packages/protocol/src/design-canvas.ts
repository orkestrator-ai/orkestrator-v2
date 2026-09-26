/** Canvas documents are backend owned; pane layouts contain only their id. */
export const DESIGN_EVENT = "design-canvas-changed";
export const DESIGN_CONFLICT = "Design revision conflict:";
export const DESIGN_MAX_HTML_BYTES = 256 * 1024;
export const DESIGN_MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
export const DESIGN_MAX_FRAMES = 64;
export const DESIGN_MAX_CANVASES = 256;
export const DESIGN_MAX_ELEMENTS = 5000;
export const DESIGN_MIN_FRAME_SIZE = 32;
export const DESIGN_MAX_FRAME_SIZE = 4096;
export const DESIGN_MAX_COORDINATE = 100_000;
/** Increment when the sanitizer or runtime changes what a validation proves. */
export const DESIGN_RUNTIME_VERSION = 2;
/** Legacy in-memory history bounds, retained for older importers of this module. */
export const DESIGN_HISTORY_LIMIT = 10;
export const DESIGN_HISTORY_MAX_BYTES = 16 * 1024 * 1024;

/** Portable version-1 document shape. Never add private fields here. */
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
  /** Content-free hint kind. Absent on legacy hints. */
  kind?: "document" | "status" | "deleted" | "restored";
  statusVersion?: number;
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
  /** Present on protocol v2: why the next undo/redo is not eligible. */
  undoBlockedReason?: string;
  redoBlockedReason?: string;
  undoLabel?: string;
  redoLabel?: string;
}
export interface DesignCanvasState {
  canvas: DesignCanvas;
  history: DesignHistoryStatus;
}
export interface DesignStyleValue {
  /** Resolved value from getComputedStyle. */
  computed: string;
  /** Inline authored declaration, when the element has one. */
  inline?: string;
  inlinePriority?: "important";
}
export interface DesignElement {
  selector: string;
  tag: string;
  text: string;
  attributes: Record<string, string>;
  styles: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
  /** Protocol v2 inspection details; absent from legacy runtimes. */
  inline?: Record<string, string>;
  inlinePriority?: Record<string, "important">;
  svg?: boolean;
  attributesTruncated?: boolean;
  textTruncated?: boolean;
  /** Structure-scoped element key (DOM path) used with a structure identity. */
  key?: string;
  /** Scroll offset of the document when inspected (frame coordinates). */
  scroll?: { x: number; y: number };
}
export interface DesignLayer {
  selector: string;
  tag: string;
  label: string;
  depth: number;
  /** Protocol v2 paging metadata. */
  childCount?: number;
  path?: string;
}
export interface DesignHierarchyPage {
  layers: DesignLayer[];
  /** Opaque cursor bound to the structure the page came from. */
  nextCursor?: string;
  total: number;
  truncated: boolean;
  bytes: number;
}
export interface DesignValidationReport {
  elementCount: number;
  maxDepth: number;
  removed: {
    scripts: number;
    handlers: number;
    externalReferences: number;
    forbiddenElements: number;
    executableUrls: number;
  };
  overElementLimit: boolean;
  html?: string;
}
export interface DesignStyleResult {
  html: string;
  /** Properties whose value the browser rejected; nothing is applied when non-empty. */
  invalid: string[];
  /** Properties whose inline declaration was already exactly this value. */
  unchanged: string[];
}
export type DesignOperation =
  | { op: "render"; html: string }
  | { op: "hitTest"; x: number; y: number }
  | { op: "inspectElement"; selector: string }
  | { op: "setStyles"; selector: string; styles: Record<string, string | null> }
  | { op: "applyStyles"; selector: string; styles: Record<string, string | null> }
  | { op: "previewStyles"; selector: string; styles: Record<string, string | null> }
  | { op: "replaceElementHtml"; selector: string; html: string }
  | { op: "appendHtml"; html: string }
  | { op: "moveElement"; selector: string; parentSelector: string; beforeSelector?: string }
  | { op: "serialize" }
  | { op: "validate"; html: string }
  | { op: "hierarchy" }
  | {
      op: "hierarchyPage";
      rootSelector?: string;
      cursor?: string;
      maxNodes?: number;
      maxBytes?: number;
      maxDepth?: number;
    }
  | { op: "setMode"; mode: "inspect" | "preview" }
  | { op: "scrollOffset" };
