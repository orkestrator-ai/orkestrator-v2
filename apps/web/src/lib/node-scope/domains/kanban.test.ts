import { describe, expect, mock, test } from "bun:test";
import type { NegotiatedDomains } from "@orkestrator/protocol/node-client";
import type { BackendClient } from "@/lib/backend/client";
import { createKanbanApi } from "@/lib/backend/kanban";
import { createConfigIntegrationsApi } from "@/lib/backend/config-integrations";
import { createSignal } from "@/lib/node-scope/signal";
import { kanban, NO_ARGS } from "./kanban";

function fakeClient(
  domains: NegotiatedDomains | null,
  answer: (command: string) => unknown = () => null,
): BackendClient & { invokeRaw: ReturnType<typeof mock> } {
  return {
    invokeRaw: mock(async (command: string) => answer(command)) as never,
    domains: createSignal<NegotiatedDomains | null>(domains),
    capabilities: createSignal<ReadonlySet<string> | null>(null),
  };
}

const task = {
  id: "t-1",
  projectId: "p-1",
  title: "Ticket",
  description: "",
  acceptanceCriteria: "",
  status: "backlog" as const,
  comments: [],
  images: [],
  createdAt: "2026-11-07T00:00:00Z",
  order: 0,
  newerField: "kept",
};

describe("kanban over a lib/backend client", () => {
  test("a node with the domain gets typed calls with the envelope; records keep every field", async () => {
    const client = fakeClient({ kanban: { min: 1, max: 1 } }, (command) =>
      command === "get_kanban_tasks" ? [task] : task,
    );
    await expect(createKanbanApi(client).getKanbanTasks("p-1")).resolves.toEqual([task]);
    expect(client.invokeRaw).toHaveBeenCalledWith(
      "get_kanban_tasks",
      { projectId: "p-1" },
      { envelope: { domain: "kanban", version: 1 } },
    );
    await kanban(client).add_kanban_comment({ taskId: "t-1", text: "hi", requestId: "r-1" });
    expect(client.invokeRaw.mock.calls.at(-1)?.[2]).toEqual({
      envelope: { domain: "kanban", version: 1, critical: ["requestId"] },
    });
  });

  test("a pre-contract node gets today's calls, answered as sent", async () => {
    const answer = { connected: false, hasToken: false };
    const client = fakeClient(null, () => answer);
    const linear = createConfigIntegrationsApi(client);
    await expect(linear.getLinearConnection()).resolves.toBe(answer);
    // A command without arguments is still sent without an arguments object.
    expect(client.invokeRaw.mock.calls.at(-1)).toEqual(["get_linear_connection"]);
    await kanban(client).get_linear_issues(NO_ARGS);
    expect(client.invokeRaw.mock.calls.at(-1)).toEqual(["get_linear_issues"]);
    await createKanbanApi(client).deleteKanbanTask("t-1");
    expect(client.invokeRaw.mock.calls.at(-1)).toEqual(["delete_kanban_task", { taskId: "t-1" }]);
  });

  test("a client that carries no negotiation uses version 0", async () => {
    const invokeRaw = mock(async () => "base64");
    const client = { invokeRaw } as unknown as BackendClient;
    await expect(createKanbanApi(client).getKanbanImageData("img-1")).resolves.toBe("base64");
    expect(invokeRaw.mock.calls).toEqual([
      ["get_kanban_image_data", { imageId: "img-1" }],
    ] as never);
  });
});
