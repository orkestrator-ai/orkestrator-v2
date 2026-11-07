/**
 * Multi-selecting environment rows in the sidebar, the same for every row
 * whichever machine owns it.
 *
 * A selection holds one id per row: this window's rows use their environment
 * ID, which is what the rest of this window's stores know them by, and another
 * machine's rows use their node-qualified key, because the same environment ID
 * can exist on two machines. The two cannot collide: a key is a JSON array.
 */
import { environmentKey } from "@orkestrator/protocol/federation";
import { getWindowScope } from "@/lib/node-scope/app-window-scope";
import { appCommandScope } from "@/lib/node-scope-slots";
import { uiStore } from "@/stores/uiStore";
import { isCommandNodeSelection } from "@/stores/windowSelectionStore";

export interface SidebarSelectionModifiers {
  shiftKey?: boolean;
  metaKey?: boolean;
}

export type SidebarSelectionResult =
  | { type: "toggle"; environmentId: string }
  | { type: "range"; ids: string[] }
  | { type: "single"; environmentId: string };

export function resolveSidebarSelection(
  environmentId: string,
  modifiers: SidebarSelectionModifiers,
  orderedIds: string[],
  selectedEnvironmentId: string | null,
  selectedEnvironmentIds: string[],
): SidebarSelectionResult {
  if (modifiers.shiftKey) {
    const clickedIndex = orderedIds.indexOf(environmentId);
    if (clickedIndex === -1) {
      return { type: "toggle", environmentId };
    }

    const anchorId = selectedEnvironmentId || selectedEnvironmentIds[0];
    if (!anchorId) {
      return { type: "range", ids: [environmentId] };
    }

    const anchorIndex = orderedIds.indexOf(anchorId);
    if (anchorIndex === -1) {
      return { type: "range", ids: [environmentId] };
    }

    const startIndex = Math.min(anchorIndex, clickedIndex);
    const endIndex = Math.max(anchorIndex, clickedIndex);
    return { type: "range", ids: orderedIds.slice(startIndex, endIndex + 1) };
  }

  if (modifiers.metaKey) {
    return { type: "toggle", environmentId };
  }

  return { type: "single", environmentId };
}

/**
 * Every selectable row, top to bottom, as the list is drawn. Reading the rows
 * rather than rebuilding their order means a range follows the screen in every
 * grouping, sort and filter, and skips whatever is collapsed.
 */
export function sidebarRowSelectionIds(): string[] {
  return Array.from(
    document.querySelectorAll("[data-sidebar-scroll] [data-environment-selection-id]"),
    (row) => row.getAttribute("data-environment-selection-id")!,
  );
}

/** The row of the environment this window shows, on whichever machine it is. */
function shownRowSelectionId(): string | null {
  const windowScope = getWindowScope();
  const selection = windowScope.selection.get();
  if (!selection?.environmentId) return null;
  return isCommandNodeSelection(windowScope, selection)
    ? selection.environmentId
    : environmentKey({ backendId: selection.nodeId, environmentId: selection.environmentId });
}

/**
 * Applies a Cmd/Ctrl- or Shift-click on a row. False for a plain click, which
 * each row answers by opening its environment.
 */
export function applySidebarModifierSelection(
  selectionId: string,
  modifiers: SidebarSelectionModifiers,
): boolean {
  if (!modifiers.shiftKey && !modifiers.metaKey) return false;
  // The sidebar's multi-selection is kept by this window's own node.
  const ui = appCommandScope().store(uiStore).getState();
  const selection = resolveSidebarSelection(
    selectionId,
    modifiers,
    sidebarRowSelectionIds(),
    shownRowSelectionId(),
    ui.selectedEnvironmentIds,
  );
  if (selection.type === "range") ui.setMultiSelection(selection.ids);
  else ui.toggleEnvironmentSelection(selectionId);
  return true;
}
