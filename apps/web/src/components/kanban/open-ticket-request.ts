import type { KanbanTask } from "@/lib/backend";

/** The part of the Kanban store a request is resolved against. */
export interface OpenTicketRequestState {
  openTicketRequest: { projectId: string; ticketId: string } | null;
  tasks: KanbanTask[];
  isLoading: boolean;
  currentProjectId: string | null;
}

export type OpenTicketResolution =
  /** No request, or one for another project's board. */
  | { kind: "none" }
  /** The board is still loading this project's tickets. */
  | { kind: "wait" }
  | { kind: "open"; task: KanbanTask }
  /** The board has loaded and the ticket is not on it. */
  | { kind: "missing"; ticketId: string };

/**
 * Decides what the board for `projectId` does with the pending request to open
 * a ticket. A request waits while the board's tickets are loading or belong to
 * another project, so a stale list never reads as "not found".
 */
export function resolveOpenTicketRequest(
  state: OpenTicketRequestState,
  projectId: string,
): OpenTicketResolution {
  const request = state.openTicketRequest;
  if (!request || request.projectId !== projectId) return { kind: "none" };
  const task = state.tasks.find(
    (candidate) => candidate.id === request.ticketId && candidate.projectId === projectId,
  );
  if (task) return { kind: "open", task };
  if (state.isLoading || state.currentProjectId !== projectId) return { kind: "wait" };
  return { kind: "missing", ticketId: request.ticketId };
}
