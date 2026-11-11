import { useCallback } from "react";
import { toast } from "sonner";
import type { CoordinatorActionCard } from "@/components/projects/coordinator-action-cards";
import { useCoordinatorActionMarks } from "@/stores/coordinatorActionMarksStore";

export interface CoordinatorActionMarking {
  /** Card ids marked done by hand; the chat shell lays them over the derived cards. */
  marked: ReadonlySet<string>;
  /**
   * Marks a card done by hand or clears the mark, reporting a failed save as a
   * toast. Absent while marks cannot be read or changed (not a coordinator
   * conversation, an older backend, an unreachable node), so cards get no menu.
   */
  onMark?: (card: CoordinatorActionCard, done: boolean, reclaimable: readonly string[]) => void;
}

/**
 * A coordinator conversation's manual action marks as the chat shell takes
 * them (`coordinatorMarkedActions`, `onMarkCoordinatorAction`). Without both
 * ids nothing is read and no menu is offered.
 */
export function useCoordinatorActionMarking(
  projectId: string | undefined,
  conversationId: string | undefined,
): CoordinatorActionMarking {
  const marks = useCoordinatorActionMarks(projectId, projectId ? conversationId : undefined);
  const setMark = marks.setMark;
  const onMark = useCallback(
    (card: CoordinatorActionCard, done: boolean, reclaimable: readonly string[]) => {
      void setMark(card.id, done, reclaimable).catch((error: unknown) => {
        toast.error(
          error instanceof Error && error.message
            ? `Could not save the mark: ${error.message}`
            : "Could not save the mark",
        );
      });
    },
    [setMark],
  );
  return { marked: marks.marked, onMark: marks.available ? onMark : undefined };
}
