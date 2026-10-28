import { describe, expect, test } from "bun:test";
import { agentMailToolCall } from "./agent-mail-tool-call";
import { groupNativeToolActivity } from "./native-message-adapters";
import type { NativeMessagePart } from "./native-message-types";

const sender = {
  kind: "tab",
  projectId: "project-1",
  environmentId: "env-1",
  tabId: "tab-1",
  incarnationId: "incarnation-1",
  agent: "claude",
  title: "Claude 1",
};

function toolPart(
  toolName: string,
  toolArgs: Record<string, unknown>,
  extra: Partial<Extract<NativeMessagePart, { type: "tool-invocation" }>> = {},
): Extract<NativeMessagePart, { type: "tool-invocation" }> {
  return { type: "tool-invocation", content: toolName, toolName, toolArgs, ...extra };
}

describe("agentMailToolCall", () => {
  test("reads a sent message from its arguments, before any result", () => {
    expect(
      agentMailToolCall(
        toolPart("mcp__orkestrator__send_message", {
          requestId: "r1",
          toEnvironmentId: "env-2",
          toTabId: "tab-2",
          subject: "Parser",
          body: "Please check the parser.",
        }),
      ),
    ).toEqual({
      tool: "send_message",
      direction: "out",
      body: "Please check the parser.",
      subject: "Parser",
      to: { environmentId: "env-2", tabId: "tab-2" },
    });
  });

  test("takes the resolved recipient, id and placement from a wrapped result", () => {
    const result = {
      identity: { environmentId: "env-1", tabId: "tab-1" },
      message: {
        id: "m1",
        from: sender,
        toEnvironmentId: "coordinator:c:main",
        toTabId: "coordinator-tab",
        placement: "pending-inject",
      },
    };
    const call = agentMailToolCall(
      toolPart(
        "send_message",
        { requestId: "r1", toEnvironmentId: "coordinator", body: "Done." },
        {
          toolTitle: "orkestrator:send_message",
          toolOutput: JSON.stringify({ content: [{ type: "text", text: JSON.stringify(result) }] }),
        },
      ),
    );
    expect(call).toMatchObject({
      messageId: "m1",
      placement: "pending-inject",
      to: { environmentId: "coordinator:c:main", tabId: "coordinator-tab" },
      from: { kind: "tab", environmentId: "env-1", tabId: "tab-1" },
    });
  });

  test("keeps the names another node reported for a recipient there", () => {
    const result = {
      message: {
        nodeId: "bk_hp",
        node: "omarchy-hp",
        messageId: "m2",
        toEnvironmentId: "leaf-env",
        toTabId: "startup-agent",
        toEnvironmentName: "fix-login-bug",
        toTabName: "Claude 2",
        placement: "pending-inject",
      },
    };
    const call = agentMailToolCall(
      toolPart(
        "mcp__orkestrator__send_message",
        { requestId: "r2", toEnvironmentId: "leaf-env", nodeId: "bk_hp", body: "Fix it." },
        { toolOutput: JSON.stringify(result) },
      ),
    );
    expect(call?.to).toEqual({
      environmentId: "leaf-env",
      tabId: "startup-agent",
      environmentName: "fix-login-bug",
      tabName: "Claude 2",
      node: "omarchy-hp",
    });
  });

  test("reads a received message from a read result", () => {
    const output = JSON.stringify([
      {
        type: "text",
        text: JSON.stringify({
          message: {
            id: "m2",
            from: sender,
            trust: "same-project",
            toEnvironmentId: "env-2",
            toTabId: "tab-2",
            subject: "Hi",
            body: "Hello there",
            placement: "stored",
          },
        }),
      },
    ]);
    expect(
      agentMailToolCall(
        toolPart("orkestrator_read_message", { messageId: "m2" }, { toolOutput: output }),
      ),
    ).toMatchObject({
      tool: "read_message",
      direction: "in",
      messageId: "m2",
      body: "Hello there",
      subject: "Hi",
      trust: "same-project",
      to: { environmentId: "env-2", tabId: "tab-2" },
    });
    // Before the deferred result loads, the call is known but has no body.
    expect(agentMailToolCall(toolPart("orkestrator__read_message", { messageId: "m2" }))).toEqual({
      tool: "read_message",
      direction: "in",
      messageId: "m2",
    });
  });

  test("leaves failed calls, other servers' tools and malformed arguments as tool rows", () => {
    const args = { requestId: "r", toEnvironmentId: "env-2", body: "x" };
    expect(agentMailToolCall(toolPart("send_message", args, { toolError: "rate-limited" }))).toBe(
      null,
    );
    expect(
      agentMailToolCall(toolPart("send_message", args, { toolTitle: "slack:send_message" })),
    ).toBe(null);
    expect(agentMailToolCall(toolPart("send_message", args, { mcpServerName: "slack" }))).toBe(
      null,
    );
    expect(agentMailToolCall(toolPart("mcp__orkestrator__send_message", { body: "x" }))).toBe(null);
    expect(agentMailToolCall(toolPart("mcp__orkestrator__read_message", {}))).toBe(null);
    expect(agentMailToolCall(toolPart("mcp__orkestrator__check_inbox", {}))).toBe(null);
  });
});

describe("mail calls in tool groups", () => {
  test("stand outside the collapsed group so the message stays visible", () => {
    const read = toolPart("Read", { file_path: "a.ts" });
    const send = toolPart("mcp__orkestrator__send_message", {
      requestId: "r",
      toEnvironmentId: "env-2",
      body: "Done.",
    });
    const grep = toolPart("Grep", { pattern: "x" });
    const grouped = groupNativeToolActivity([read, send, grep]);
    expect(grouped.map((part) => part.type)).toEqual([
      "tool-group",
      "tool-invocation",
      "tool-group",
    ]);
    expect(grouped[1]).toBe(send);
  });
});
