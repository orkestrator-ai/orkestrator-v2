import { appCommandScope } from "@/lib/node-scope-slots";
import { requestCloseGlobalSettings } from "@/lib/settings-navigation";
import { kanbanStore } from "@/stores/kanbanStore";
import { uiStore } from "@/stores/uiStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";

/**
 * Leaves Settings for the project's Kanban board on this window's own node and
 * opens one ticket there. The board opens the ticket once it has loaded it, so
 * this works whether or not the board was on screen.
 */
export function openTicketOnBoard(projectId: string, ticketId: string): void {
  requestCloseGlobalSettings();
  useRemoteWorkspaceStore.getState().showLocal();
  const scope = appCommandScope();
  scope.store(kanbanStore).getState().requestOpenTicket(projectId, ticketId);
  const ui = scope.store(uiStore).getState();
  ui.selectProject(projectId);
  ui.setProjectBoardTab("kanban");
}
