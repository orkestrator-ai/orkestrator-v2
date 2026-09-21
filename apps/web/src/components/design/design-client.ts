import type {
  DesignCanvas,
  DesignCanvasState,
  DesignChanges,
} from "@orkestrator/protocol/design-canvas";
import { invoke } from "@/lib/native/backend";

export function designAction<T>(
  environmentId: string,
  action: string,
  input: Record<string, unknown> = {},
): Promise<T> {
  return invoke<T>("design_action", { environmentId, action, input });
}
export function getCanvas(environmentId: string, canvasId: string) {
  return designAction<DesignCanvas>(environmentId, "get_canvas", { canvasId });
}
export function getCanvasState(environmentId: string, canvasId: string) {
  return designAction<DesignCanvasState>(environmentId, "get_canvas_state", { canvasId });
}
export function getChanges(
  environmentId: string,
  canvasId: string,
  generation: string | undefined,
  after: number,
) {
  return invoke<DesignChanges>("design_changes", { environmentId, canvasId, generation, after });
}
