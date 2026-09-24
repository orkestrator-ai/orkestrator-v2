import { createContext, useContext } from "react";
import type { DesignFrame } from "@orkestrator/protocol/design-canvas";
import type { DesignCanvasController } from "./design-controller";
import type { DesignSelection } from "./design-selection";
import type { DesignFrameBridge } from "./frame-bridge";

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
  select(selection: DesignSelection | null): void;
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
  focusFrame(frameId: string): void;
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
