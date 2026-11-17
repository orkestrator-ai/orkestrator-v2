import { createContext, useContext } from "react";
import type { DesignFrame } from "@orkestrator/protocol/design-canvas";
import type { DesignCanvasController } from "./design-controller";
import type { DesignSelection } from "./design-selection";
import type { DesignFrameBridge } from "./frame-bridge";
import type { DesignDownloadScope, DesignImageFormat } from "./design-frame-download";

export type DesignFrameAction =
  | "rename"
  | "duplicate"
  | "delete"
  | "ask-agent"
  | "retry-validation"
  | "restore-previous"
  | "fit"
  | "properties";

export type GeometryPatch = Partial<Pick<DesignFrame, "x" | "y" | "width" | "height" | "name">>;

/** Stable actions shared by canvas children; avoids threading a dozen callbacks. */
export interface DesignCanvasActions {
  controller: DesignCanvasController;
  environmentId: string;
  canvasId: string;
  /** Starts an asynchronous selection; its result applies only while this generation is current. */
  beginSelection(): number;
  /** Returns false when an older asynchronous result was discarded. */
  select(selection: DesignSelection | null, generation?: number): boolean;
  /** Absolute final values for one gesture; `base` is the committed frame the gesture started from. */
  submitGeometry(base: DesignFrame, patch: GeometryPatch, gestureId: string, label: string): void;
  submitElementResize(
    selection: DesignSelection,
    width: number,
    height: number,
    gestureId: string,
  ): void;
  registerBridge(frameId: string, bridge: DesignFrameBridge | null): void;
  frameRendered(frameId: string, contentId: string): void;
  pin(frameId: string, pinned: boolean): void;
  reportError(error: unknown, frameId?: string): void;
  exitPreview(): void;
  frameAction(frameId: string, action: DesignFrameAction): void;
  /**
   * Focus moved to a frame's chrome. Focusing a frame outside the board
   * selection clears it unless `keepSelection` (an additive click in progress).
   */
  focusFrame(frameId: string, options?: { keepSelection?: boolean }): void;
  /**
   * Selects a whole frame (board): outlined on the canvas, removable with
   * Delete when it is the only one. `additive` adds it to, or removes it from,
   * the current board selection instead of replacing it.
   */
  selectFrame(frameId: string, options?: { additive?: boolean }): void;
  /**
   * A frame move or resize started from its chrome. When the frame is part of
   * a board selection of several, a move carries the whole selection with it.
   */
  beginFrameGesture(frameId: string, mode: "move" | "resize"): void;
  /**
   * The raw pointer travel of the gesture in canvas pixels. Returns the
   * frame's snapped geometry: on the grid, or on another frame's edge with a
   * guide drawn. `free` (Alt held) skips snapping.
   */
  updateFrameGesture(
    frameId: string,
    delta: { dx: number; dy: number },
    options?: { free?: boolean },
  ): GeometryPatch;
  /**
   * Ends the gesture. On commit the other frames of a group move are
   * submitted with the same offset; the dragged frame submits its own patch.
   */
  endFrameGesture(frameId: string, commit: boolean, gestureId: string): void;
  /**
   * Downloads frames as images or a PDF: this frame, the board selection, or
   * every frame on the canvas. Settles when the file was handed to the
   * browser; failures are reported on the canvas, never rejected.
   */
  downloadFrames(
    frameId: string,
    scope: DesignDownloadScope,
    format: DesignImageFormat,
  ): Promise<void>;
}

export const DesignCanvasContext = createContext<DesignCanvasActions | null>(null);

export function useDesignCanvasActions(): DesignCanvasActions {
  const actions = useContext(DesignCanvasContext);
  if (!actions) throw new Error("DesignCanvasContext is missing");
  return actions;
}

let gestures = 0;
export function nextGestureId(prefix: string) {
  gestures++;
  return `${prefix}-${Date.now().toString(36)}-${gestures}`;
}
