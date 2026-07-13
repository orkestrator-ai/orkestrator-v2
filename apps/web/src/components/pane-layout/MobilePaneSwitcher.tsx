import type { ReactNode } from "react";

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
  const selectedPaneId = panes.some((pane) => pane.id === activePaneId)
    ? activePaneId
    : panes[0]?.id;

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
              hidden={!selected}
              className="h-full min-h-0"
            >
              {renderPane(pane.id, selected)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
