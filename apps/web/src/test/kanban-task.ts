import { normalizeTicketContent } from "@orkestrator/protocol/ticket-sections";
import type { KanbanTask } from "@/lib/backend/kanban";

type TicketWithoutContent = Omit<KanbanTask, "kind" | "sections"> &
  Partial<Pick<KanbanTask, "kind" | "sections">>;

/**
 * A test ticket as the backend sends it: its kind and sections derived from
 * its text the way the backend derives them, unless the test gives its own.
 */
export function kanbanTask(task: TicketWithoutContent): KanbanTask {
  if (task.kind && task.sections) return task as KanbanTask;
  const content = normalizeTicketContent(task, { now: task.createdAt });
  return { ...task, kind: task.kind ?? content.kind, sections: task.sections ?? content.sections };
}
