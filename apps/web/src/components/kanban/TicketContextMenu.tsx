import type { ReactElement, ReactNode } from "react";
import { Hammer, SquareArrowOutUpRight, Trash2 } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

export interface TicketContextMenuProps {
  /** The card or row the menu opens on; it must accept a ref and DOM props. */
  children: ReactElement;
  /** Names the ticket in the menu's accessible label. */
  ticketLabel: string;
  /** No menu at all (a drag preview): the trigger renders on its own. */
  disabled?: boolean;
  onOpen: () => void;
  /** Starts the build launcher. Absent hides Build. */
  onBuild?: () => void;
  /** Why Build cannot start now (a build is running); shown and disables the item. */
  buildDisabledReason?: string;
  /** Asks to delete the ticket; the caller confirms first. Absent hides Delete. */
  onDelete?: () => void;
  /** Why Delete is unavailable now; shown and disables the item. */
  deleteDisabledReason?: string;
  /** Board-specific items, after Build (Clear status, Run graph…, Share). */
  extraItems?: ReactNode;
}

/**
 * The right-click menu a ticket card or row shares on the Kanban and Linear
 * boards: Open, Build…, any board-specific items, then Delete… apart from the
 * rest. Only the primary pointer button starts a card drag, so right-clicking
 * a draggable card opens this menu without picking the card up.
 */
export function TicketContextMenu({
  children,
  ticketLabel,
  disabled,
  onOpen,
  onBuild,
  buildDisabledReason,
  onDelete,
  deleteDisabledReason,
  extraItems,
}: TicketContextMenuProps) {
  if (disabled) return children;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent
        className="w-52"
        aria-label={`Actions for ${ticketLabel}`}
        data-testid="ticket-context-menu"
        // The card under the menu opens on click; a click in the menu is not one.
        onClick={(event) => event.stopPropagation()}
      >
        <ContextMenuItem onSelect={onOpen}>
          <SquareArrowOutUpRight className="h-4 w-4" />
          Open
        </ContextMenuItem>
        {onBuild && (
          <ContextMenuItem
            disabled={Boolean(buildDisabledReason)}
            title={buildDisabledReason}
            onSelect={onBuild}
          >
            <Hammer className="h-4 w-4" />
            <span className="flex min-w-0 flex-col">
              <span>Build…</span>
              {buildDisabledReason && (
                <span className="truncate text-[11px] text-muted-foreground">
                  {buildDisabledReason}
                </span>
              )}
            </span>
          </ContextMenuItem>
        )}
        {extraItems}
        {onDelete && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              variant="destructive"
              disabled={Boolean(deleteDisabledReason)}
              title={deleteDisabledReason}
              onSelect={onDelete}
            >
              <Trash2 className="h-4 w-4" />
              <span className="flex min-w-0 flex-col">
                <span>Delete…</span>
                {deleteDisabledReason && (
                  <span className="truncate text-[11px] text-muted-foreground">
                    {deleteDisabledReason}
                  </span>
                )}
              </span>
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
