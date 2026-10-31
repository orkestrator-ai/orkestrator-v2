import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { listen } from "@/lib/native/events";
import { invoke } from "@/lib/native/backend";
import { FederationProvider } from "./FederationProvider";
import { RootChangesApprovalDialog } from "./RootChangesApprovalDialog";
import type { NodeActionRequestView } from "@/lib/portal/portal-store";
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

describe("the user picks which uncommitted changes a coordinator's worker gets", () => {
  test("lists the checkout's changes, pre-ticks the suggestion, and approves only the picked files", async () => {
    const resolved: Array<Record<string, unknown>> = [];
    let pending = [
      {
        requestId: "req-changes",
        kind: "apply-root-changes",
        targets: [
          {
            nodeId: "bk_self",
            nodeName: "this machine",
            environmentId: "worker-1",
            environmentName: "auth-fix",
            projectId: "project-1",
            files: ["src/a.ts", "src/gone.ts"],
          },
        ],
        reason: "Start from my edits",
        requestedBy: { projectId: "project-1" },
        state: "pending",
      },
    ];
    invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "list_node_action_requests") return pending;
      if (command === "list_project_root_changes") {
        expect(args).toEqual({ projectId: "project-1" });
        return {
          files: [
            { path: "src/a.ts", status: "modified" },
            { path: "src/b.ts", status: "untracked" },
            { path: "old.ts", status: "deleted" },
          ],
          truncated: false,
          conflicts: 0,
          headCommit: "a".repeat(40),
        };
      }
      if (command === "resolve_node_action_request") {
        resolved.push(args);
        pending = [];
        return { ...args, state: "executed", result: { code: "applied", message: "Applied." } };
      }
      return undefined;
    });
    render(
      <FederationProvider>
        <NodeActionRequestsDialog />
      </FederationProvider>,
    );
    const dialog = await screen.findByTestId("root-changes-request");
    expect(dialog.textContent).toContain("Apply uncommitted changes to “auth-fix”?");
    expect(dialog.textContent).toContain("Start from my edits");
    await screen.findByRole("checkbox", { name: "src/b.ts" });
    // The suggestion that is still changed starts ticked; the vanished one is ignored.
    expect(screen.getByRole("checkbox", { name: "src/a.ts" }).getAttribute("data-state")).toBe(
      "checked",
    );
    expect(screen.getByRole("checkbox", { name: "src/b.ts" }).getAttribute("data-state")).toBe(
      "unchecked",
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox", { name: "old.ts" }));
    });
    expect(resolved).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Apply 2 files" }));
    await waitFor(() =>
      expect(resolved).toEqual([
        {
          requestId: "req-changes",
          decision: "approve",
          approval: { paths: ["src/a.ts", "old.ts"] },
        },
      ]),
    );
    await waitFor(() => expect(screen.queryByTestId("root-changes-request") === null).toBe(true));
  });
});

const rootRequest = {
  requestId: "root-approval",
  kind: "apply-root-changes",
  state: "pending",
  targets: [
    {
      nodeId: "self",
      nodeName: "Self",
      environmentId: "worker",
      projectId: "project",
      files: ["a.ts"],
    },
  ],
  requestedBy: {
    projectId: "project",
    coordinatorEnvironmentId: "coordinator:c:v",
    coordinatorTabId: "c",
  },
} as NodeActionRequestView;

for (const state of ["listing-error", "empty", "conflicts", "over-limit"]) {
  test(`root-change approval handles ${state} and still permits rejection`, async () => {
    const resolved: Array<Record<string, unknown>> = [];
    const settled = mock(() => {});
    invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "list_project_root_changes") {
        if (state === "listing-error") throw new Error("Checkout is unavailable");
        return {
          files:
            state === "empty"
              ? []
              : state === "over-limit"
                ? Array.from({ length: 501 }, (_, i) => ({
                    path: `file-${i}.ts`,
                    status: "modified",
                  }))
                : [{ path: "a.ts", status: "modified" }],
          conflicts: state === "conflicts" ? 2 : 0,
          truncated: state === "conflicts",
          headCommit: "a".repeat(40),
        };
      }
      if (command === "resolve_node_action_request") {
        resolved.push(args);
        return { ...rootRequest, state: "rejected" };
      }
      return undefined;
    });
    render(<RootChangesApprovalDialog request={rootRequest} onSettled={settled} />);
    if (state === "listing-error") await screen.findByText("Checkout is unavailable");
    else if (state === "empty")
      await screen.findByText("The checkout has no uncommitted changes now.");
    else if (state === "conflicts") {
      await screen.findByText("2 conflicted files are left out.");
      expect(screen.getByText("Only the first 1 changed files are listed.")).toBeTruthy();
    } else {
      await screen.findByRole("checkbox", { name: "file-500.ts" });
      fireEvent.click(screen.getByRole("button", { name: "Select all" }));
      await screen.findByText("Pick at most 500 files.");
      expect(
        (screen.getByRole("button", { name: "Apply 501 files" }) as HTMLButtonElement).disabled,
      ).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Clear" }));
      expect(
        (screen.getByRole("button", { name: "Apply 0 files" }) as HTMLButtonElement).disabled,
      ).toBe(true);
    }
    if (state === "listing-error" || state === "empty")
      expect(
        (screen.getByRole("button", { name: "Apply 0 files" }) as HTMLButtonElement).disabled,
      ).toBe(true);
    expect(resolved).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() =>
      expect(resolved).toEqual([{ requestId: "root-approval", decision: "reject" }]),
    );
    await waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
  });
}

for (const outcome of ["rejected", "failed", "error"])
  test(`root-change approval handles ${outcome} resolution`, async () => {
    const settled = mock(() => {});
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "list_project_root_changes")
        return {
          files: [{ path: "a.ts", status: "modified" }],
          conflicts: 0,
          truncated: false,
          headCommit: "a".repeat(40),
        };
      if (command === "resolve_node_action_request") {
        if (outcome === "error") throw new Error("Connection lost");
        return { ...rootRequest, state: outcome, result: { message: "Not applied" } };
      }
    });
    render(<RootChangesApprovalDialog request={rootRequest} onSettled={settled} />);
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Apply 1 file" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply 1 file" }));
    await waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
    expect(
      (screen.getByRole("button", { name: "Apply 1 file" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

test("an account switch names the machine, the provider and the account, and says what it bills", async () => {
  const resolved: Array<Record<string, unknown>> = [];
  let pending = [
    {
      requestId: "req-switch",
      kind: "switch-agent-account",
      targets: [
        {
          nodeId: "bk_self",
          nodeName: "this machine",
          platform: "claude",
          accountId: "acct-work",
          accountLabel: "Work (work@example.com)",
        },
      ],
      reason: "Switch to an account with usage left when the limit is hit.",
      state: "pending",
    },
  ];
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === "list_node_action_requests") return pending;
    if (command === "resolve_node_action_request") {
      resolved.push(args);
      pending = [];
      return { ...args, state: "executed", result: { code: "switched", message: "Switched." } };
    }
    return undefined;
  });
  render(
    <FederationProvider>
      <NodeActionRequestsDialog />
    </FederationProvider>,
  );
  const dialog = await screen.findByTestId("node-action-request");
  expect(dialog.textContent).toContain(
    "Switch the active Claude account on this machine to “Work (work@example.com)”?",
  );
  expect(dialog.textContent).toContain("billed to");
  expect(dialog.textContent).toContain("Switch to an account with usage left");
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  await waitFor(() => expect(resolved).toEqual([{ requestId: "req-switch", decision: "approve" }]));
});
