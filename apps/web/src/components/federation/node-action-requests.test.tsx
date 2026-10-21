import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { listen } from "@/lib/native/events";
import { invoke } from "@/lib/native/backend";
import { FederationProvider } from "./FederationProvider";
import { NodeActionRequestsDialog } from "./NodeActionRequestsDialog";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
});

describe("CO-04 the user confirms a coordinator's deletion request", () => {
  test("the dialog names node and environment; only Approve resolves it", async () => {
    const resolved: Array<Record<string, unknown>> = [];
    let pending = [
      {
        requestId: "req-1",
        kind: "delete-environment",
        targets: [
          {
            nodeId: "bk_leaf",
            nodeName: "Build box",
            environmentId: "e1",
            environmentName: "feature-a",
          },
        ],
        reason: "Remove feature-a, it is merged.",
        state: "pending",
      },
    ];
    invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "list_node_action_requests") return pending;
      if (command === "resolve_node_action_request") {
        resolved.push(args);
        pending = [];
        return { ...args, state: "executed", result: { code: "deleted", message: "Deleted." } };
      }
      return undefined;
    });
    render(
      <FederationProvider>
        <NodeActionRequestsDialog />
      </FederationProvider>,
    );
    const dialog = await screen.findByTestId("node-action-request");
    expect(dialog.textContent).toContain("Delete “feature-a” on Build box?");
    expect(dialog.textContent).toContain("Nothing happens unless you approve it");
    expect(resolved).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Delete on Build box" }));
    await waitFor(() => expect(resolved).toEqual([{ requestId: "req-1", decision: "approve" }]));
    await waitFor(() => expect(screen.queryByTestId("node-action-request") === null).toBe(true));
  });

  test("Reject never approves", async () => {
    const resolved: Array<Record<string, unknown>> = [];
    invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "list_node_action_requests") {
        return resolved.length
          ? []
          : [
              {
                requestId: "req-2",
                kind: "delete-environment",
                targets: [{ nodeId: "bk_self", nodeName: "this node", environmentId: "e2" }],
                state: "pending",
              },
            ];
      }
      if (command === "resolve_node_action_request") {
        resolved.push(args);
        return { ...args, state: "rejected" };
      }
      return undefined;
    });
    render(
      <FederationProvider>
        <NodeActionRequestsDialog />
      </FederationProvider>,
    );
    await screen.findByTestId("node-action-request");
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(resolved).toEqual([{ requestId: "req-2", decision: "reject" }]));
  });
});

test("pending coordinator approvals appear after stream resync without remount", async () => {
  const handlers = new Map<string, Set<(event: { payload: unknown }) => void>>();
  const listenMock = listen as unknown as ReturnType<typeof mock>;
  listenMock.mockImplementation(
    async (event: string, handler: (event: { payload: unknown }) => void) => {
      const listeners = handlers.get(event) ?? new Set();
      listeners.add(handler);
      handlers.set(event, listeners);
      return () => listeners.delete(handler);
    },
  );
  let pending = false;
  invokeMock.mockImplementation(async (command: string) =>
    command === "list_node_action_requests"
      ? pending
        ? [
            {
              requestId: "late",
              kind: "delete-environment",
              targets: [{ nodeId: "bk_leaf", nodeName: "Leaf", environmentId: "e" }],
              state: "pending",
            },
          ]
        : []
      : undefined,
  );
  render(
    <FederationProvider>
      <NodeActionRequestsDialog />
    </FederationProvider>,
  );
  await waitFor(() => expect(handlers.has("native-event-stream-connected")).toBe(true));
  pending = true;
  await act(async () => {
    for (const handler of handlers.get("native-event-stream-connected") ?? [])
      handler({ payload: undefined });
  });
  expect((await screen.findByTestId("node-action-request")).textContent).toContain("Leaf");
  cleanup();
  listenMock.mockReset();
  listenMock.mockImplementation(() => Promise.resolve(() => {}));
});
