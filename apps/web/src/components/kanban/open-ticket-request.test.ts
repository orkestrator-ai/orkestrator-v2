import { describe, expect, test } from "bun:test";
import type { KanbanTask } from "@/lib/backend";
import { resolveOpenTicketRequest, type OpenTicketRequestState } from "./open-ticket-request";

function task(id: string, projectId: string): KanbanTask {
  return { id, projectId, title: `Ticket ${id}` } as KanbanTask;
}

function state(overrides: Partial<OpenTicketRequestState> = {}): OpenTicketRequestState {
  return {
    openTicketRequest: { projectId: "p1", ticketId: "418" },
    tasks: [],
    isLoading: false,
    currentProjectId: "p1",
    ...overrides,
  };
}

describe("resolveOpenTicketRequest", () => {
  test("does nothing without a request or for another project's board", () => {
    expect(resolveOpenTicketRequest(state({ openTicketRequest: null }), "p1")).toEqual({
      kind: "none",
    });
    expect(resolveOpenTicketRequest(state(), "p2")).toEqual({ kind: "none" });
  });

  test("opens the ticket once it is among the project's loaded tasks", () => {
    const wanted = task("418", "p1");
    expect(resolveOpenTicketRequest(state({ tasks: [task("1", "p1"), wanted] }), "p1")).toEqual({
      kind: "open",
      task: wanted,
    });
  });

  test("a ticket of the same id on another project does not match", () => {
    expect(resolveOpenTicketRequest(state({ tasks: [task("418", "p2")] }), "p1")).toEqual({
      kind: "missing",
      ticketId: "418",
    });
  });

  test("waits while the board is loading or still holds another project's tasks", () => {
    expect(resolveOpenTicketRequest(state({ isLoading: true }), "p1")).toEqual({ kind: "wait" });
    expect(resolveOpenTicketRequest(state({ currentProjectId: "p2" }), "p1")).toEqual({
      kind: "wait",
    });
  });

  test("reports a ticket missing only once the board has loaded without it", () => {
    expect(resolveOpenTicketRequest(state({ tasks: [task("1", "p1")] }), "p1")).toEqual({
      kind: "missing",
      ticketId: "418",
    });
  });
});
