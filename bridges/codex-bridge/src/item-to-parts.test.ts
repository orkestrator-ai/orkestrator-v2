import { describe, expect, test } from "bun:test";
import { itemToParts, stringifyUnknown } from "./index.js";
import type { NormalizedPart } from "./index.js";
import type { ThreadItem } from "@openai/codex-sdk";

const DUMMY_CWD = "/tmp/test-workspace";

describe("itemToParts", () => {
  test("converts agent_message to text part", async () => {
    const item: ThreadItem = {
      id: "msg-1",
      type: "agent_message",
      text: "Hello, world!",
    };

    const parts = await itemToParts(item, DUMMY_CWD);

    expect(parts).toEqual([{ type: "text", content: "Hello, world!" }]);
  });

  test("converts reasoning to thinking part", async () => {
    const item: ThreadItem = {
      id: "reason-1",
      type: "reasoning",
      text: "Let me think about this...",
    };

    const parts = await itemToParts(item, DUMMY_CWD);

    expect(parts).toEqual([
      { type: "thinking", content: "Let me think about this..." },
    ]);
  });

  test("converts completed command_execution to success tool-invocation", async () => {
    const item = {
      id: "cmd-1",
      type: "command_execution" as const,
      command: "ls -la",
      aggregated_output: "file1.txt\nfile2.txt",
      status: "completed" as const,
    };

    const parts = await itemToParts(item, DUMMY_CWD);

    expect(parts).toEqual([
      {
        type: "tool-invocation",
        content: "ls -la",
        toolName: "bash",
        toolArgs: { command: "ls -la" },
        toolState: "success",
        toolTitle: "ls -la",
        toolOutput: "file1.txt\nfile2.txt",
        toolError: undefined,
      },
    ]);
  });

  test("converts failed command_execution to failure with error", async () => {
    const item = {
      id: "cmd-2",
      type: "command_execution" as const,
      command: "exit 1",
      aggregated_output: "command not found",
      status: "failed" as const,
    };

    const parts = await itemToParts(item, DUMMY_CWD);

    expect(parts).toHaveLength(1);
    expect(parts[0]!.toolState).toBe("failure");
    expect(parts[0]!.toolError).toBe("command not found");
  });

  test("converts pending command_execution to pending state", async () => {
    const item = {
      id: "cmd-3",
      type: "command_execution" as const,
      command: "sleep 10",
      aggregated_output: "",
      status: "in_progress" as const,
    };

    const parts = await itemToParts(item, DUMMY_CWD);

    expect(parts).toHaveLength(1);
    expect(parts[0]!.toolState).toBe("pending");
  });

  test("converts failed command with empty output to default error message", async () => {
    const item = {
      id: "cmd-4",
      type: "command_execution" as const,
      command: "bad-command",
      aggregated_output: "",
      status: "failed" as const,
    };

    const parts = await itemToParts(item, DUMMY_CWD);

    expect(parts[0]!.toolError).toBe("Command failed");
  });

  test("converts web_search to tool-invocation with query", async () => {
    const item: ThreadItem = {
      id: "search-1",
      type: "web_search",
      query: "how to test async functions",
    };

    const parts = await itemToParts(item, DUMMY_CWD);

    expect(parts).toEqual([
      {
        type: "tool-invocation",
        content: "how to test async functions",
        toolName: "web_search",
        toolArgs: { query: "how to test async functions" },
        toolState: "success",
        toolTitle: "how to test async functions",
      },
    ]);
  });

  test("converts todo_list to tool-invocation with structured args", async () => {
    const item: ThreadItem = {
      id: "todo-1",
      type: "todo_list",
      items: [
        { text: "Write tests", completed: true },
        { text: "Fix bug", completed: false },
      ],
    };

    const parts = await itemToParts(item, DUMMY_CWD);

    expect(parts).toHaveLength(1);
    const part = parts[0]!;

    expect(part.type).toBe("tool-invocation");
    expect(part.toolName).toBe("todo_list");
    expect(part.toolState).toBe("success");
    expect(part.toolTitle).toBe("Todo List");
    expect(part.content).toBe("[x] Write tests\n[ ] Fix bug");
    expect(part.toolOutput).toBe("[x] Write tests\n[ ] Fix bug");
    expect(part.toolArgs).toEqual({
      todos: [
        { content: "Write tests", status: "completed" },
        { content: "Fix bug", status: "pending" },
      ],
    });
  });

  test("converts empty todo_list to tool-invocation with empty args", async () => {
    const item: ThreadItem = {
      id: "todo-2",
      type: "todo_list",
      items: [],
    };

    const parts = await itemToParts(item, DUMMY_CWD);

    expect(parts).toHaveLength(1);
    expect(parts[0]!.toolArgs).toEqual({ todos: [] });
    expect(parts[0]!.content).toBe("");
    expect(parts[0]!.toolOutput).toBe("");
  });

  test("converts error to tool-result with failure state", async () => {
    const item: ThreadItem = {
      id: "err-1",
      type: "error",
      message: "Something went wrong",
    };

    const parts = await itemToParts(item, DUMMY_CWD);

    expect(parts).toEqual([
      {
        type: "tool-result",
        content: "Something went wrong",
        toolName: "error",
        toolState: "failure",
        toolError: "Something went wrong",
      },
    ]);
  });

  test("converts mcp_tool_call with completed status to success", async () => {
    const item = {
      id: "mcp-1",
      type: "mcp_tool_call" as const,
      server: "my-server",
      tool: "fetch_data",
      arguments: { url: "https://example.com" },
      status: "completed" as const,
      result: { content: [], structured_content: { data: "test" } },
    };

    const parts = await itemToParts(item, DUMMY_CWD);

    expect(parts).toHaveLength(1);
    const part = parts[0]!;
    expect(part.type).toBe("tool-invocation");
    expect(part.toolName).toBe("fetch_data");
    expect(part.toolArgs).toEqual({ url: "https://example.com" });
    expect(part.toolState).toBe("success");
    expect(part.toolTitle).toBe("my-server:fetch_data");
  });

  test("converts mcp_tool_call with failed status and error", async () => {
    const item = {
      id: "mcp-2",
      type: "mcp_tool_call" as const,
      server: "my-server",
      tool: "broken_tool",
      arguments: null,
      status: "failed" as const,
      error: { message: "Tool crashed" },
    };

    const parts = await itemToParts(item, DUMMY_CWD);

    expect(parts).toHaveLength(1);
    expect(parts[0]!.toolState).toBe("failure");
    expect(parts[0]!.toolError).toBe("Tool crashed");
  });

  test("converts mcp_tool_call with null arguments to empty args", async () => {
    const item = {
      id: "mcp-3",
      type: "mcp_tool_call" as const,
      server: "s",
      tool: "t",
      arguments: null,
      status: "completed" as const,
    };

    const parts = await itemToParts(item, DUMMY_CWD);

    expect(parts[0]!.toolArgs).toEqual({});
  });

  test("returns empty array for unknown item type", async () => {
    const item = { id: "unknown-1", type: "future_type" } as unknown as ThreadItem;

    const parts = await itemToParts(item, DUMMY_CWD);

    expect(parts).toEqual([]);
  });
});

describe("stringifyUnknown", () => {
  test("returns undefined for undefined", () => {
    expect(stringifyUnknown(undefined)).toBeUndefined();
  });

  test("returns string values as-is", () => {
    expect(stringifyUnknown("hello")).toBe("hello");
  });

  test("JSON-stringifies objects", () => {
    const result = stringifyUnknown({ key: "value" });
    expect(result).toBe('{\n  "key": "value"\n}');
  });

  test("JSON-stringifies arrays", () => {
    const result = stringifyUnknown([1, 2, 3]);
    expect(result).toBe("[\n  1,\n  2,\n  3\n]");
  });

  test("converts numbers to string via String()", () => {
    expect(stringifyUnknown(42)).toBe("42");
  });

  test("converts null to string via JSON.stringify", () => {
    expect(stringifyUnknown(null)).toBe("null");
  });

  test("handles circular references gracefully", () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    const result = stringifyUnknown(obj);
    expect(result).toBe("[object Object]");
  });
});
