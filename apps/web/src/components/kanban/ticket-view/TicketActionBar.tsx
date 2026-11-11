import type { ReactNode } from "react";

/**
 * A ticket view tab's action bar. It sits above the tab's scrolling column,
 * outside it, so it stays at the top whatever the column scrolls to.
 */
export function TicketActionBar({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      role="toolbar"
      aria-label={label}
      data-testid="ticket-action-bar"
      className="@container sticky top-0 z-10 flex shrink-0 flex-wrap items-center gap-2 border-b border-divider bg-background px-4 py-2 @3xl:px-6"
    >
      {children}
    </div>
  );
}
