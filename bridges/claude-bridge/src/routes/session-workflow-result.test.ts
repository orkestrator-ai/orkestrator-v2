import { expect, test } from "bun:test";
import { createSession, mockQuery, track } from "../services/session-manager-test-harness.js";
import { Hono } from "hono";
import sessionRoutes from "./session.js";

const app = new Hono().route("/session", sessionRoutes);

test("refuses a malformed workflow-result attempt before claiming the turn", async () => {
  const session = createSession("malformed workflow result");
  track(session.id);
  const queries = mockQuery.mock.calls.length;
  for (const malformed of [
    { workflowResultTool: "submit_review_report" },
    { workflowResultTool: "rm -rf", workflowResultKey: "key" },
    { workflowResultTool: "submit_a", workflowResultKey: "key", workflowResultSlots: [] },
    {
      workflowResultTool: "submit_a",
      workflowResultKey: "key",
      workflowResultSlots: [{ tool: "submit_b", resultKey: "key" }],
    },
    {
      workflowResultTool: "submit_a",
      workflowResultKey: "key",
      workflowResultExtraTools: ["send_message"],
    },
    { workflowResultExtraTools: ["read_artifact"] },
  ]) {
    const response = await app.request(`/session/${session.id}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "work", requestId: "malformed", ...malformed }),
    });
    expect(response.status).toBe(400);
  }
  expect(mockQuery.mock.calls.length).toBe(queries);
  expect(session.dispatchedRequestIds?.has("malformed") ?? false).toBe(false);
});
