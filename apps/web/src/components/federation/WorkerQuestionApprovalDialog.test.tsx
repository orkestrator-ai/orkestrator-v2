import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@/lib/native/backend";
import type { NodeActionRequestView } from "@/lib/portal/portal-store";
import { FederationProvider } from "./FederationProvider";
import { NodeActionRequestsDialog } from "./NodeActionRequestsDialog";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
});

const request: NodeActionRequestView = {
  requestId: "worker-answer-1",
  kind: "answer-worker-question",
  state: "pending",
  reason: "The ticket says Postgres",
  targets: [
    {
      nodeId: "bk_self",
      nodeName: "this machine",
      environmentId: "worker-1",
      environmentName: "auth-fix",
      projectId: "p1",
    },
  ],
  requestedBy: { projectId: "p1" },
  workerQuestion: {
    tabId: "agent-1",
    tabName: "Claude 1",
    interactionId: "q-1",
    revision: 2,
    title: "Database choice",
    questions: [
      {
        id: "db",
        prompt: "Which database should the service use?",
        required: true,
        multiple: false,
        allowFreeText: true,
        options: [
          { id: "pg", label: "Postgres", description: "The default" },
          { id: "sqlite", label: "SQLite" },
        ],
      },
      {
        id: "extras",
        prompt: "Which extras?",
        required: false,
        multiple: true,
        allowFreeText: false,
        options: [
          { id: "cache", label: "Cache" },
          { id: "search", label: "Search" },
        ],
      },
    ],
    proposed: [
      { questionId: "db", optionIds: ["pg"] },
      { questionId: "extras", optionIds: ["cache"] },
    ],
  },
};

function backend(state = "executed") {
  const resolved: Array<Record<string, unknown>> = [];
  let pending = [request];
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === "list_node_action_requests") return pending;
    if (command === "resolve_node_action_request") {
      resolved.push(args);
      pending = [];
      return {
        ...request,
        state: args.decision === "approve" ? state : "rejected",
        result: { code: state === "stale" ? "stale" : "answered", message: "Done." },
      };
    }
    return undefined;
  });
  return resolved;
}

async function open() {
  render(
    <FederationProvider>
      <NodeActionRequestsDialog />
    </FederationProvider>,
  );
  return screen.findByTestId("worker-question-request");
}

const option = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });

describe("the user confirms a coordinator's answer to a worker's question", () => {
  test("shows the worker, tab, question, options, proposal and reason; Approve sends the proposal", async () => {
    const resolved = backend();
    const dialog = await open();
    expect(dialog.textContent).toContain("Answer the question in “Claude 1” of “auth-fix”?");
    expect(dialog.textContent).toContain("The ticket says Postgres");
    expect(dialog.textContent).toContain("nothing is sent to the worker unless you approve");
    expect(dialog.textContent).toContain("Which database should the service use?");
    expect(dialog.textContent).toContain("Database choice");
    expect(dialog.textContent).toContain("The default");
    expect(dialog.textContent).toContain("Coordinator's proposal");
    expect(option("Postgres").getAttribute("aria-pressed")).toBe("true");
    expect(option("SQLite").getAttribute("aria-pressed")).toBe("false");
    expect(option("Cache").getAttribute("aria-pressed")).toBe("true");
    expect(resolved).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Approve and send" }));
    // Unchanged: the backend sends the proposal it stored.
    await waitFor(() =>
      expect(resolved).toEqual([{ requestId: "worker-answer-1", decision: "approve" }]),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("worker-question-request") === null).toBe(true),
    );
  });

  test("an edited answer is the one approved", async () => {
    const resolved = backend();
    await open();
    await act(async () => {
      fireEvent.click(option("SQLite"));
      fireEvent.click(option("Search"));
    });
    expect(option("Postgres").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("Edited by you")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve and send" }));
    await waitFor(() =>
      expect(resolved).toEqual([
        {
          requestId: "worker-answer-1",
          decision: "approve",
          approval: {
            answers: [
              { questionId: "db", optionIds: ["sqlite"] },
              { questionId: "extras", optionIds: ["cache", "search"] },
            ],
          },
        },
      ]),
    );
  });

  test("a written answer replaces the single choice, and an empty required answer cannot be approved", async () => {
    const resolved = backend();
    await open();
    const text = screen.getByRole("textbox", { name: /Other answer/ });
    await act(async () => {
      fireEvent.change(text, { target: { value: "MySQL 8" } });
    });
    expect(option("Postgres").getAttribute("aria-pressed")).toBe("false");
    await act(async () => {
      fireEvent.change(text, { target: { value: "" } });
    });
    const approve = screen.getByRole("button", { name: "Approve and send" }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(screen.getByText(/needs an answer/)).toBeTruthy();
    fireEvent.click(approve);
    await act(async () => {
      fireEvent.change(text, { target: { value: "MySQL 8" } });
    });
    fireEvent.click(screen.getByRole("button", { name: "Approve and send" }));
    await waitFor(() =>
      expect(resolved).toEqual([
        {
          requestId: "worker-answer-1",
          decision: "approve",
          approval: {
            answers: [
              { questionId: "db", freeText: "MySQL 8" },
              { questionId: "extras", optionIds: ["cache"] },
            ],
          },
        },
      ]),
    );
  });

  test("a worker on another node is named with its node", async () => {
    invokeMock.mockImplementation(async (command: string) =>
      command === "list_node_action_requests"
        ? [
            {
              ...request,
              targets: [{ ...request.targets[0]!, nodeId: "bk_leaf", nodeName: "Build box" }],
            },
          ]
        : undefined,
    );
    const dialog = await open();
    expect(dialog.textContent).toContain(
      "Answer the question in “Claude 1” of “auth-fix” on Build box?",
    );
  });

  test("Decline never approves", async () => {
    const resolved = backend();
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() =>
      expect(resolved).toEqual([{ requestId: "worker-answer-1", decision: "reject" }]),
    );
  });
});
