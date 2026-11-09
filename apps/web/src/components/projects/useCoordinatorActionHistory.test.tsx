import { afterEach, expect, test } from "bun:test";
import { waitFor } from "@testing-library/react";
import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";
import { useCoordinatorActionHistory } from "./useCoordinatorActionHistory";
import { coordinatorActionCards } from "./coordinator-action-cards";
import type { NativeMessage } from "@/lib/chat/native-message-types";

afterEach(cleanupNodeScopes);
const old: NativeMessage = {
  id: "historic",
  role: "assistant",
  content: "",
  createdAt: "2026-11-09",
  parts: [
    {
      type: "tool-invocation",
      content: "",
      toolName: "orkestrator_mark_question",
      toolArgs: { title: "Historical question" },
      toolState: "success",
    },
  ],
};
function Probe({ enabled = true, session = "session" }: { enabled?: boolean; session?: string }) {
  const evidence = useCoordinatorActionHistory(enabled, "environment", "tab", "codex", session);
  return (
    <output>
      {coordinatorActionCards(evidence ?? [])
        .map((card) => card.title)
        .join(",")}
    </output>
  );
}
function client() {
  return new FakeNodeClient({
    invoke: {
      get_native_agent_projection_update: {
        syncVersion: 1,
        status: "snapshot",
        token: "token",
        historyEpoch: "epoch",
        historyCursor: "older",
        historyComplete: false,
        projection: {
          platform: "codex",
          environmentId: "environment",
          sessionId: "session",
          messages: Array.from({ length: 512 }, (_, index) => ({
            ...old,
            id: `tail-${index}`,
            parts: [],
          })),
          interactions: [],
          composerControls: [],
          capabilities: {},
          turn: { phase: "idle" },
          revision: 1,
          generation: 1,
          connection: "connected",
        },
      },
      get_native_agent_message_page: {
        syncVersion: 1,
        messages: [old],
        historyEpoch: "epoch",
        complete: true,
        truncated: false,
      },
    },
  });
}
test("two node-scoped clients reload a bounded projection and independently discover historical cards", async () => {
  for (let index = 0; index < 2; index++) {
    const node = client();
    const view = renderInNodeScope(<Probe />, { client: node });
    await waitFor(() => expect(view.container.textContent).toBe("Historical question"));
    expect(node.calls("get_native_agent_projection_update")).toHaveLength(1);
    expect(node.calls("get_native_agent_message_page")).toHaveLength(1);
    expect(node.calls("get_native_agent_message_page")[0]!.args).toMatchObject({
      environmentId: "environment",
      before: "older",
      limit: 200,
    });
    view.rerender(<Probe session="replacement" enabled={false} />);
    expect(view.container.textContent).toBe("");
    cleanupNodeScopes();
  }
});
test("worker conversations do not scan action history", () => {
  const node = client();
  renderInNodeScope(<Probe enabled={false} />, { client: node });
  expect(node.invocations).toHaveLength(0);
});
