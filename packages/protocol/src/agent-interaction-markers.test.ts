import { describe, expect, test } from "bun:test";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  AGENT_INTERACTION_HUMAN_REQUIRED_TEXT,
  agentInteractionTextBody,
  agentInteractionToolHintsFromMcpAnnotations,
  agentInteractionToolHintTag,
  isAgentInteractionRequest,
  parseAgentInteractionToolHints,
  type AgentInteractionRequest,
} from "./agent-interactions.js";

const CREATED_AT = 1_800_000_000_000;

function permission(extra: Record<string, unknown> = {}): AgentInteractionRequest {
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
  } as AgentInteractionRequest;
}

describe("human-required marker", () => {
  test("is optional, and only `true` is accepted", () => {
    expect(isAgentInteractionRequest(permission())).toBe(true);
    expect(isAgentInteractionRequest(permission({ humanRequired: true }))).toBe(true);
    for (const humanRequired of [false, "true", 1, null, {}]) {
      expect(isAgentInteractionRequest(permission({ humanRequired }))).toBe(false);
    }
  });

  test("text-only consumers say a person must answer, ahead of the body", () => {
    expect(agentInteractionTextBody(permission({ humanRequired: true }))).toBe(
      `${AGENT_INTERACTION_HUMAN_REQUIRED_TEXT}\nTool: mcp__linear__create_issue`,
    );
    expect(agentInteractionTextBody({ presentation: {}, humanRequired: true })).toBe(
      AGENT_INTERACTION_HUMAN_REQUIRED_TEXT,
    );
    expect(agentInteractionTextBody({ presentation: {} })).toBeUndefined();
  });
});

describe("tool hints", () => {
  test("are optional, booleans only, from the four MCP members, never empty", () => {
    expect(
      isAgentInteractionRequest(
        permission({
          toolHints: { readOnly: false, destructive: true, idempotent: false, openWorld: true },
        }),
      ),
    ).toBe(true);
    expect(isAgentInteractionRequest(permission({ toolHints: { readOnly: true } }))).toBe(true);
    const invalid: unknown[] = [
      {},
      { readOnly: "yes" },
      { destructive: null },
      { readOnlyHint: true },
      { readOnly: true, trusted: true },
      [true],
      true,
      null,
    ];
    for (const toolHints of invalid) {
      expect(isAgentInteractionRequest(permission({ toolHints }))).toBe(false);
    }
  });

  test("read from MCP annotations, dropping anything that is not a declared boolean", () => {
    expect(
      agentInteractionToolHintsFromMcpAnnotations({
        title: "Create issue",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      }),
    ).toEqual({ readOnly: false, destructive: true, idempotent: false, openWorld: true });
    expect(
      agentInteractionToolHintsFromMcpAnnotations({ readOnlyHint: "true", destructiveHint: true }),
    ).toEqual({ destructive: true });
    // No defaults are filled in: an absent hint stays absent.
    expect(agentInteractionToolHintsFromMcpAnnotations({ title: "x" })).toBeUndefined();
    for (const malformed of [undefined, null, "readOnly", 3, [], { readOnly: true }]) {
      expect(agentInteractionToolHintsFromMcpAnnotations(malformed)).toBeUndefined();
    }
  });

  test("parse the shared shape a bridge forwards, keeping only booleans", () => {
    expect(parseAgentInteractionToolHints({ readOnly: true, idempotent: false })).toEqual({
      readOnly: true,
      idempotent: false,
    });
    expect(
      parseAgentInteractionToolHints({ destructive: "yes", openWorld: true, x: true }),
    ).toEqual({ openWorld: true });
    for (const malformed of [undefined, null, {}, { destructive: 1 }, "x", [true]]) {
      expect(parseAgentInteractionToolHints(malformed)).toBeUndefined();
    }
  });

  test("give one tag, and none for a contradictory or absent declaration", () => {
    expect(agentInteractionToolHintTag({ readOnly: true })).toBe("read-only");
    expect(agentInteractionToolHintTag({ readOnly: true, destructive: false })).toBe("read-only");
    expect(agentInteractionToolHintTag({ destructive: true })).toBe("destructive");
    expect(agentInteractionToolHintTag({ readOnly: false, destructive: true })).toBe("destructive");
    expect(agentInteractionToolHintTag({ readOnly: true, destructive: true })).toBeUndefined();
    expect(agentInteractionToolHintTag({ destructive: false })).toBeUndefined();
    expect(agentInteractionToolHintTag({ idempotent: true, openWorld: true })).toBeUndefined();
    expect(agentInteractionToolHintTag(undefined)).toBeUndefined();
  });

  test("text-only consumers get the tag after the source line", () => {
    expect(
      agentInteractionTextBody(
        permission({
          source: { kind: "mcp-server", name: "linear" },
          toolHints: { destructive: true },
          humanRequired: true,
        }),
      ),
    ).toBe(
      [
        "MCP server: linear",
        "The MCP server describes this tool as destructive.",
        AGENT_INTERACTION_HUMAN_REQUIRED_TEXT,
        "Tool: mcp__linear__create_issue",
      ].join("\n"),
    );
    expect(agentInteractionTextBody(permission({ toolHints: { openWorld: true } }))).toBe(
      "Tool: mcp__linear__create_issue",
    );
  });
});
