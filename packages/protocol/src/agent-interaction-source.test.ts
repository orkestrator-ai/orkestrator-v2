import { describe, expect, test } from "bun:test";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  AGENT_INTERACTION_LIMITS,
  agentInteractionSourceLine,
  agentInteractionSourceScopeLabel,
  agentInteractionTextBody,
  isAgentInteractionRequest,
  mcpServerInteractionSource,
  type AgentInteractionRequest,
} from "./agent-interactions.js";

const CREATED_AT = 1_800_000_000_000;

function permission(extra: Partial<AgentInteractionRequest> = {}): AgentInteractionRequest {
  return {
    version: AGENT_INTERACTION_CONTRACT_VERSION,
    id: "interaction-permission",
    provider: "claude",
    kind: "permission",
    origin: "interactive-native",
    sessionId: "session-1",
    state: "pending",
    revision: 0,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    expiresAt: CREATED_AT + 300_000,
    presentation: {
      title: "Allow mcp__linear__create_issue",
      body: "Tool: mcp__linear__create_issue",
      questions: [],
    },
    ...extra,
  };
}

describe("interaction source", () => {
  test("is optional: a request without one is valid as before", () => {
    expect(isAgentInteractionRequest(permission())).toBe(true);
  });

  test("accepts an MCP server source with or without a scope", () => {
    expect(
      isAgentInteractionRequest(
        permission({ source: { kind: "mcp-server", name: "linear", scope: "project" } }),
      ),
    ).toBe(true);
    expect(
      isAgentInteractionRequest(permission({ source: { kind: "mcp-server", name: "x" } })),
    ).toBe(true);
  });

  test("rejects an unknown kind, extra keys, a malformed scope and an empty or long name", () => {
    const invalid: unknown[] = [
      { kind: "plugin", name: "linear" },
      { kind: "mcp-server", name: "linear", trusted: true },
      { kind: "mcp-server", name: "linear", scope: "Project Settings" },
      { kind: "mcp-server", name: "linear", scope: "" },
      { kind: "mcp-server", name: "linear", scope: 3 },
      { kind: "mcp-server", name: "" },
      { kind: "mcp-server", name: "x".repeat(AGENT_INTERACTION_LIMITS.maxSourceNameLength + 1) },
      { kind: "mcp-server" },
      "linear",
      null,
    ];
    for (const source of invalid) {
      expect(isAgentInteractionRequest({ ...permission(), source })).toBe(false);
    }
  });

  test("builds a source from provider values, dropping a scope it cannot show", () => {
    expect(mcpServerInteractionSource("linear", "user")).toEqual({
      kind: "mcp-server",
      name: "linear",
      scope: "user",
    });
    expect(mcpServerInteractionSource("linear", "<script>")).toEqual({
      kind: "mcp-server",
      name: "linear",
    });
    expect(mcpServerInteractionSource("linear")).toEqual({ kind: "mcp-server", name: "linear" });
    expect(mcpServerInteractionSource("")).toBeUndefined();
    expect(mcpServerInteractionSource(undefined, "user")).toBeUndefined();
    expect(mcpServerInteractionSource("x".repeat(257))).toBeUndefined();
  });

  test("words known scopes, and never reads an unknown one as the agent host", () => {
    expect(agentInteractionSourceScopeLabel("project")).toBe("project settings");
    expect(agentInteractionSourceScopeLabel("sdk")).toBe("the agent host");
    expect(agentInteractionSourceScopeLabel("future_scope")).toBe("other configuration");
    expect(agentInteractionSourceScopeLabel("constructor")).toBe("other configuration");
    expect(
      agentInteractionSourceLine({ kind: "mcp-server", name: "linear", scope: "constructor" }),
    ).toBe("MCP server: linear (from other configuration)");
    expect(agentInteractionSourceScopeLabel(undefined)).toBeUndefined();
  });

  test("gives text-only consumers the source line ahead of the body", () => {
    const source = { kind: "mcp-server" as const, name: "linear", scope: "user" };
    expect(agentInteractionSourceLine(source)).toBe("MCP server: linear (from user settings)");
    expect(agentInteractionSourceLine({ kind: "mcp-server", name: "linear" })).toBe(
      "MCP server: linear",
    );
    expect(agentInteractionTextBody(permission({ source }))).toBe(
      "MCP server: linear (from user settings)\nTool: mcp__linear__create_issue",
    );
    expect(agentInteractionTextBody({ presentation: {}, source })).toBe(
      "MCP server: linear (from user settings)",
    );
    expect(agentInteractionTextBody(permission())).toBe("Tool: mcp__linear__create_issue");
  });
});
