import type { DesignElement, DesignFrame } from "@orkestrator/protocol/design-canvas";
import type { DesignFrameMeta } from "@orkestrator/protocol/design-operations";

/**
 * A structure-scoped element reference. It is a reference, not authority: every
 * edit still carries the observed frame revision and structure identity.
 */
export interface DesignSelection {
  frameId: string;
  /** Frame revision observed when the element was inspected. */
  revision: number;
  /** Backend structure identity observed (absent on v1 backends). */
  structureId?: string;
  contentId?: string;
  element: DesignElement;
}

export type SelectionValidity = "current" | "refresh" | "stale" | "missing";

/**
 * `current`: same revision. `refresh`: style/geometry changed but the structure
 * is the same, so the reference still holds and should be re-inspected.
 * `stale`: structure changed (or v1 revision changed); reselect before editing.
 */
export function selectionValidity(
  selection: DesignSelection,
  frame: DesignFrame | undefined,
  meta: DesignFrameMeta | undefined,
): SelectionValidity {
  if (!frame) return "missing";
  if (frame.revision === selection.revision) return "current";
  if (selection.structureId && meta && meta.structureId === selection.structureId) return "refresh";
  return "stale";
}
