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
    for (const kind of ["started", "interacted", "interrupted", "completed"] as const) {
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
    // What remains after plan 03: the prompt itself, Codex's own review-mode
    // boundaries (review here is an Orkestrator-owned pipeline), and the raw
    // half of a call whose rendered half is already in the transcript.
    for (const type of [
      "userMessage",
      "enteredReviewMode",
      "exitedReviewMode",
      "functionCallOutput",
    ]) {
      expect(adaptAppServerItem({ id: "id", type })).toEqual({
        item: null,
        unsupportedType: type,
      });
    }
  });

  test("renders a generated image as an image item, by path and never by bytes", () => {
    expect(
      adaptAppServerItem({
        id: "img-1",
        type: "imageGeneration",
        status: "completed",
        revisedPrompt: "a cat wearing a hard hat",
        result: "ignored",
        savedPath: "/workspace/out/cat.png",
        failure: null,
      }),
    ).toEqual({
      item: {
        id: "img-1",
        type: "image",
        text: "a cat wearing a hard hat",
        path: "/workspace/out/cat.png",
        source: "generated",
      },
    });
  });

  test("renders a viewed image titled by its file name", () => {
    expect(
      adaptAppServerItem({ id: "img-2", type: "imageView", path: "/workspace/shots/error.png" }),
    ).toEqual({
      item: {
        id: "img-2",
        type: "image",
        text: "error.png",
        path: "/workspace/shots/error.png",
        source: "viewed",
      },
    });
  });

  test("renders a compaction as a boundary with no invented summary", () => {
    // Codex reports the boundary and not what the compaction produced. The
    // boundary itself is the information.
    expect(adaptAppServerItem({ id: "c-1", type: "contextCompaction" })).toEqual({
      item: { id: "c-1", type: "compaction", text: "" },
    });
  });

  test("renders a hook's injected prompt as a status row", () => {
    expect(
      adaptAppServerItem({
        id: "h-1",
        type: "hookPrompt",
        fragments: [
          { text: "Use tabs.", hookRunId: "r1" },
          { text: "Never edit generated files.", hookRunId: "r2" },
        ],
      }),
    ).toEqual({
      item: {
        id: "h-1",
        type: "status",
        text: "Hook added context: Use tabs.\nNever edit generated files.",
        severity: "info",
      },
    });
  });

  test("a hook prompt with no readable fragments is not a status row", () => {
    expect(adaptAppServerItem({ id: "h-2", type: "hookPrompt", fragments: [] })).toEqual({
      item: null,
      unsupportedType: "hookPrompt",
    });
  });

  test("renders a sleep as a status row naming the duration", () => {
    expect(adaptAppServerItem({ id: "s-1", type: "sleep", durationMs: 4_000 })).toMatchObject({
      item: { type: "status", text: "Waited 4s" },
    });
    expect(adaptAppServerItem({ id: "s-2", type: "sleep", durationMs: 250 })).toMatchObject({
      item: { type: "status", text: "Waited 0.25s" },
    });
    expect(adaptAppServerItem({ id: "s-3", type: "sleep" })).toMatchObject({
      item: { type: "status", text: "Waited" },
    });
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
