import type { CSSProperties, ReactNode } from "react";

export interface MobilePaneOption {
  id: string;
  label: string;
}

interface MobilePaneSwitcherProps {
  panes: MobilePaneOption[];
  activePaneId?: string;
  onSelect: (paneId: string) => void;
  renderPane: (paneId: string, isActive: boolean) => ReactNode;
}

/** The pane the switcher shows: the active pane, or the first when that is not in the split. */
export function selectMobilePaneId(
  panes: ReadonlyArray<{ id: string }>,
  activePaneId: string | undefined,
): string | undefined {
  return panes.some((pane) => pane.id === activePaneId) ? activePaneId : panes[0]?.id;
}

/**
 * How the switcher hides a pane: laid out at full size underneath the visible
 * one, never `display: none`. A pane without a layout box loses its scroll
 * offsets (a virtualized transcript re-measures itself to its end) and a
 * terminal in it would be fitted to nothing. Opacity also hides any descendant
 * that sets `visibility: visible`; `inert` keeps the pane out of the tab order
 * and the accessibility tree, as `visibility: hidden` alone already does.
 */
const HIDDEN_PANE_STYLE: CSSProperties = {
  visibility: "hidden",
  opacity: 0,
  pointerEvents: "none",
};

/**
 * Mobile replacement for resize handles. Every pane stays mounted so terminal
 * and agent views can continue receiving authoritative backend updates while
 * another pane is visible.
 */
export function MobilePaneSwitcher({
  panes,
  activePaneId,
  onSelect,
  renderPane,
}: MobilePaneSwitcherProps) {
  const selectedPaneId = selectMobilePaneId(panes, activePaneId);

  if (!selectedPaneId) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        role="tablist"
        aria-label="Split panes"
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-muted/30 p-1"
      >
        {panes.map((pane, index) => {
          const selected = pane.id === selectedPaneId;
          return (
            <button
              key={pane.id}
              id={`mobile-pane-tab-${pane.id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`mobile-pane-panel-${pane.id}`}
              className={`min-h-9 shrink-0 rounded px-3 text-xs ${
                selected ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"
              }`}
              onClick={() => onSelect(pane.id)}
            >
              {index + 1}. {pane.label}
            </button>
          );
        })}
      </div>
      <div className="relative min-h-0 flex-1">
        {panes.map((pane) => {
          const selected = pane.id === selectedPaneId;
          return (
            <div
              key={pane.id}
              id={`mobile-pane-panel-${pane.id}`}
              role="tabpanel"
              aria-labelledby={`mobile-pane-tab-${pane.id}`}
              inert={!selected}
              data-state={selected ? "active" : "inactive"}
              className="absolute inset-0 min-h-0"
              style={selected ? undefined : HIDDEN_PANE_STYLE}
            >
              {renderPane(pane.id, selected)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
