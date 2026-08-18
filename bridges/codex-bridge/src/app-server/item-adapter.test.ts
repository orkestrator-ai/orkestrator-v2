import { describe, expect, test } from "bun:test";
import { adaptAppServerItem, planUpdateToTodoList, userMessageClientId } from "./item-adapter.js";

describe("item adapter edge cases", () => {
  test("defaults malformed command and file fields without throwing", () => {
    expect(
      adaptAppServerItem({
        id: "command",
        type: "commandExecution",
        status: "unknown",
        command: 4,
        aggregatedOutput: null,
        exitCode: "zero",
      }).item,
    ).toEqual({
      id: "command",
      type: "command_execution",
      command: "",
      aggregated_output: "",
      status: "in_progress",
    });
    expect(
      adaptAppServerItem({
        id: "file",
        type: "fileChange",
        status: "declined",
        changes: [
          null,
          { path: "", kind: "add" },
          { path: "a.ts", kind: "delete" },
          { path: "b.ts", kind: { type: "unexpected" } },
        ],
      }).item,
    ).toMatchObject({
      status: "failed",
      changes: [
        { path: "a.ts", kind: "delete" },
        { path: "b.ts", kind: "update" },
      ],
    });
  });

  test("retains structured MCP results and maps unknown status to pending", () => {
    expect(
      adaptAppServerItem({
        id: "mcp",
        type: "mcpToolCall",
        server: "server",
        tool: "tool",
        status: "starting",
        arguments: null,
        result: {
          content: "malformed",
          structuredContent: { value: 1 },
        },
      }).item,
    ).toMatchObject({
      type: "mcp_tool_call",
      status: "in_progress",
      arguments: {},
      result: { content: [], structured_content: { value: 1 } },
    });
  });

  test("renders dynamic tool calls and trusts an explicit failed outcome", () => {
    expect(
      adaptAppServerItem({
        id: "dynamic",
        type: "dynamicToolCall",
        namespace: "functions",
        tool: "exec",
        status: "completed",
        success: false,
        arguments: 'const r = await tools.exec_command({ cmd: "git status" });',
        contentItems: [{ type: "inputText", text: "command failed" }],
      }).item,
    ).toEqual({
      id: "dynamic",
      type: "dynamic_tool_call",
      namespace: "functions",
      tool: "exec",
      status: "failed",
      arguments: 'const r = await tools.exec_command({ cmd: "git status" });',
      content_items: [{ type: "inputText", text: "command failed" }],
    });

    expect(
      adaptAppServerItem({
        id: "pending",
        type: "dynamicToolCall",
        tool: "exec",
        status: "inProgress",
        arguments: null,
        contentItems: null,
      }).item,
    ).toMatchObject({
      type: "dynamic_tool_call",
      status: "in_progress",
      content_items: [],
    });
  });

  test("never settles a dynamic tool call that is still running", () => {
    // Reporting a terminal outcome for an in-flight call is the same class of
    // mistake as reporting `idle` for a turn that is still executing.
    expect(
      adaptAppServerItem({
        id: "dynamic",
        type: "dynamicToolCall",
        tool: "exec",
        status: "inProgress",
        success: false,
        arguments: null,
        contentItems: null,
      }).item,
    ).toMatchObject({ status: "in_progress" });

    // A finished call trusts its own status even when `success` disagrees,
    // matching how `mcpToolCall` and `commandStatus` already behave.
    expect(
      adaptAppServerItem({
        id: "dynamic",
        type: "dynamicToolCall",
        tool: "exec",
        status: "failed",
        success: true,
        arguments: null,
        contentItems: null,
      }).item,
    ).toMatchObject({ status: "failed" });

    expect(
      adaptAppServerItem({
        id: "dynamic",
        type: "dynamicToolCall",
        tool: "exec",
        status: "completed",
        success: true,
        arguments: null,
        contentItems: null,
      }).item,
    ).toMatchObject({ status: "completed" });
  });

  test("drops a dynamic tool call with no usable identity, and a malformed namespace", () => {
    // Without a tool name there is nothing to render or key on.
    expect(
      adaptAppServerItem({
        id: "dynamic",
        type: "dynamicToolCall",
        status: "completed",
        arguments: null,
        contentItems: null,
      }),
    ).toEqual({ item: null, unsupportedType: "dynamicToolCall" });

    expect(
      adaptAppServerItem({
        id: "dynamic",
        type: "dynamicToolCall",
        tool: "exec",
        namespace: 42,
        status: "completed",
        arguments: null,
        contentItems: null,
      }).item,
    ).not.toHaveProperty("namespace");

    // Non-array content is normalized rather than passed through.
    expect(
      adaptAppServerItem({
        id: "dynamic",
        type: "dynamicToolCall",
        tool: "exec",
        status: "completed",
        arguments: { cmd: "ls" },
        contentItems: "nope",
      }).item,
    ).toMatchObject({ content_items: [], arguments: { cmd: "ls" } });
  });

  test("rejects malformed collaboration and subagent identities", () => {
    expect(
      adaptAppServerItem({
        id: "collab",
        type: "collabAgentToolCall",
        tool: "",
      }),
    ).toEqual({ item: null, unsupportedType: "collabAgentToolCall" });
    expect(
      adaptAppServerItem({
        id: "sub",
        type: "subAgentActivity",
        agentThreadId: "",
      }),
    ).toEqual({ item: null, unsupportedType: "subAgentActivity" });
    expect(
      adaptAppServerItem({
        id: "sub",
        type: "subAgentActivity",
        kind: "futureKind",
        agentThreadId: "child-1",
      }),
    ).toEqual({ item: null, unsupportedType: "subAgentActivity" });
  });

  test("maps every known subagent activity kind exactly", () => {
    for (const kind of ["started", "interacted", "interrupted"] as const) {
      expect(
        adaptAppServerItem({
          id: `sub-${kind}`,
          type: "subAgentActivity",
          kind,
          agentThreadId: "child-1",
        }).item,
      ).toMatchObject({
        type: "subagent_activity",
        activity: kind,
        agent_thread_id: "child-1",
      });
    }
  });

  test("explicitly classifies every understood non-rendered item", () => {
    for (const type of [
      "userMessage",
      "hookPrompt",
      "imageView",
      "imageGeneration",
      "sleep",
      "enteredReviewMode",
      "exitedReviewMode",
      "contextCompaction",
    ]) {
      expect(adaptAppServerItem({ id: "id", type })).toEqual({
        item: null,
        unsupportedType: type,
      });
    }
  });

  test("plan and client-id helpers ignore malformed elements", () => {
    expect(
      planUpdateToTodoList("turn", [
        null,
        { step: 4, status: "completed" },
        { step: "valid", status: "completed" },
      ]),
    ).toEqual({
      id: "plan-turn",
      type: "todo_list",
      items: [{ text: "valid", completed: true }],
    });
    expect(userMessageClientId({ type: "userMessage", clientId: 4 })).toBeNull();
    expect(userMessageClientId({ type: "agentMessage", clientId: "x" })).toBeNull();
  });
});
