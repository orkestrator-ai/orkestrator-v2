import { afterEach, describe, expect, test } from "bun:test";
import { resolveOpenTicketRequest } from "@/components/kanban/open-ticket-request";
import type { KanbanTask } from "@/lib/backend";
import { kanbanStore } from "@/stores/kanbanStore";
import { uiStore } from "@/stores/uiStore";
import { appCommandStore } from "@/test/app-command-store";
import { openTicketOnBoard } from "./open-ticket-on-board";

const CLOSE_EVENT = "orkestrator:close-global-settings";

afterEach(() => {
  appCommandStore(kanbanStore).getState().clearOpenTicketRequest();
});

describe("openTicketOnBoard", () => {
  test("closes Settings, selects the project's Kanban board and stores the request", () => {
    let closed = 0;
    const onClose = () => (closed += 1);
    window.addEventListener(CLOSE_EVENT, onClose);
    try {
      openTicketOnBoard("p2", "418");
    } finally {
      window.removeEventListener(CLOSE_EVENT, onClose);
    }
    expect(closed).toBe(1);
    expect(appCommandStore(kanbanStore).getState().openTicketRequest).toEqual({
      projectId: "p2",
      ticketId: "418",
    });
    const ui = appCommandStore(uiStore).getState();
    expect(ui.selectedProjectId).toBe("p2");
    expect(ui.projectBoardTab).toBe("kanban");
  });

  test("the board opens the ticket once its tasks load, and reports one that is gone", () => {
    openTicketOnBoard("p2", "418");
    const store = appCommandStore(kanbanStore);
    const request = () => resolveOpenTicketRequest(store.getState(), "p2");

    // The board mounts and starts loading: the request waits.
    store.setState({ tasks: [], isLoading: true, currentProjectId: "p2" });
    expect(request()).toEqual({ kind: "wait" });

    // It loads without the ticket: the board clears the request and says so.
    store.setState({ isLoading: false });
    expect(request()).toEqual({ kind: "missing", ticketId: "418" });

    // It loads with the ticket: the board opens it.
    const wanted = { id: "418", projectId: "p2", title: "Ticket" } as KanbanTask;
    store.setState({ tasks: [wanted] });
    expect(request()).toEqual({ kind: "open", task: wanted });
  });
});
