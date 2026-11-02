import { afterEach, describe, expect, test } from "bun:test";
import type { AgentInteractionRequest } from "@orkestrator/protocol/agent-interactions";
import type { PublicInteraction } from "@orkestrator/protocol/public-api-resources";
import { cleanupSessionHarnesses, setup } from "./test-provider.js";

/**
 * `session.interactions` shows a request as text, so an MCP server source
 * reaches the CLI as the first line of the body, as the card shows it.
 */

afterEach(cleanupSessionHarnesses);

function permission(
  sessionId: string,
  overrides: Partial<AgentInteractionRequest>,
): AgentInteractionRequest {
  return {
    version: 1,
    id: "permission-1",
    provider: "claude",
    kind: "permission",
    origin: "interactive-native",
    sessionId,
    state: "pending",
    revision: 0,
    presentation: {
      title: "Allow mcp__linear__create_issue",
      body: "Tool: mcp__linear__create_issue",
      questions: [],
    },
    createdAt: Date.now() - 1_000,
    updatedAt: Date.now() - 1_000,
    expiresAt: Date.now() + 5 * 60_000,
    ...overrides,
  } as AgentInteractionRequest;
}

describe("session.interactions source", () => {
  test("names the MCP server ahead of the body, and leaves a request without one as it was", async () => {
    const { harness, stub } = await setup();
    const started = await harness.call<{ sessionId: string }>(
      "session.start",
      { environmentId: "env-1", agent: "claude", prompt: "do the thing" },
      { requestId: "source-start" },
    );
    if (!started.ok) throw new Error(`session.start failed: ${started.error.code}`);
    const providerSessionId = stub.sends[0]!.sessionId;
    stub.pending.push(
      permission(providerSessionId, {
        source: { kind: "mcp-server", name: "linear", scope: "project" },
      }),
      permission(providerSessionId, {
        id: "permission-2",
        presentation: { title: "Allow WebSearch", body: "Tool: WebSearch", questions: [] },
      }),
    );

    const listed = await harness.call<{ items: PublicInteraction[] }>("session.interactions", {
      sessionId: started.result.sessionId,
    });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.result.items.map((item) => item.body)).toEqual([
      "MCP server: linear (from project settings)\nTool: mcp__linear__create_issue",
      "Tool: WebSearch",
    ]);
  });
});
