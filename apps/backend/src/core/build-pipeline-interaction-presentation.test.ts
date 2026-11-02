import { describe, expect, test } from "bun:test";
import type { AgentInteractionRequest } from "@orkestrator/protocol/agent-interactions";
import type { PipelineSession } from "@orkestrator/protocol/build-pipeline";
import { interactionPresentation } from "./build-pipeline-service-helpers.js";

const session = {
  sessionKey: "session-key",
  sdkSessionId: "sdk-1",
  phase: "building",
} as unknown as PipelineSession;

function permission(overrides: Partial<AgentInteractionRequest> = {}): AgentInteractionRequest {
  return {
    version: 1,
    id: "permission-1",
    provider: "claude",
    kind: "permission",
    origin: "build-pipeline",
    sessionId: "sdk-1",
    state: "pending",
    revision: 0,
    presentation: {
      title: "Allow mcp__linear__create_issue",
      body: "Tool: mcp__linear__create_issue",
      questions: [],
    },
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  } as AgentInteractionRequest;
}

describe("pipeline interaction presentation", () => {
  test("a declined request's summary names its MCP server ahead of the body", () => {
    const summary = interactionPresentation(
      permission({ source: { kind: "mcp-server", name: "linear", scope: "user" } }),
      session,
      "journal-1",
      2_000,
      "decline-and-continue",
    );
    expect(summary.body).toBe(
      "MCP server: linear (from user settings)\nTool: mcp__linear__create_issue",
    );
  });

  test("a request without a source keeps its body, and a hidden one shows none", () => {
    expect(
      interactionPresentation(permission(), session, "journal-1", 2_000, "decline-and-continue")
        .body,
    ).toBe("Tool: mcp__linear__create_issue");
    const hidden = interactionPresentation(
      permission({ source: { kind: "mcp-server", name: "linear" } }),
      session,
      "journal-1",
      2_000,
      "deny-and-fail",
    );
    expect(hidden).not.toHaveProperty("body");
  });
});
