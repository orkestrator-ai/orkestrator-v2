import { describe, expect, test } from "bun:test";
import { readTodos, renderToolCall } from "./tool-rendering.js";

describe("renderToolCall", () => {
  test("renders a shell call with both streams labelled", () => {
    const rendered = renderToolCall({
      type: "shell",
      args: { command: "bun test", workingDirectory: "/w" },
      result: {
        status: "success",
        value: { exitCode: 0, signal: "", stdout: "ok\n", stderr: "warn\n", executionTime: 5 },
      },
    });
    expect(rendered.toolName).toBe("shell");
    expect(rendered.toolTitle).toBe("bun test");
    expect(rendered.toolArgs).toEqual({ command: "bun test", workingDirectory: "/w" });
    expect(rendered.toolOutput).toBe("ok\n\n[stderr]\nwarn\n");
    expect(rendered.toolError).toBeUndefined();
  });

  test("reports a non-zero exit as a failure without discarding output", () => {
    const rendered = renderToolCall({
      type: "shell",
      args: { command: "false" },
      result: {
        status: "success",
        value: { exitCode: 1, signal: "", stdout: "partial", stderr: "", executionTime: 1 },
      },
    });
    expect(rendered.toolOutput).toBe("partial");
    expect(rendered.toolError).toBe("Command exited with status 1");
  });

  test("maps an edit result onto the shared diff shape", () => {
    const rendered = renderToolCall({
      type: "edit",
      args: { path: "src/a.ts" },
      result: {
        status: "success",
        value: { linesAdded: 3, linesRemoved: 1, diffString: "@@ -1 +1 @@" },
      },
    });
    expect(rendered.toolDiff).toEqual({
      filePath: "src/a.ts",
      additions: 3,
      deletions: 1,
      diff: "@@ -1 +1 @@",
    });
  });

  test("a write carries its post-image but never claims the file was empty", () => {
    const rendered = renderToolCall({
      type: "write",
      args: { path: "new.txt", fileText: "hello" },
      result: { status: "success", value: { path: "new.txt", linesCreated: 1, fileSize: 5 } },
    });
    expect(rendered.toolDiff).toEqual({ filePath: "new.txt", additions: 1, after: "hello" });
    expect(rendered.toolDiff?.before).toBeUndefined();
  });

  test("surfaces a tool error through the uniform error branch", () => {
    const rendered = renderToolCall({
      type: "read",
      args: { path: "missing.ts" },
      result: { status: "error", error: { message: "ENOENT" } },
    });
    expect(rendered.toolError).toBe("ENOENT");
    expect(rendered.toolOutput).toBeUndefined();
  });

  test("reads generateImage's differently spelled error field", () => {
    const rendered = renderToolCall({
      type: "generateImage",
      args: { description: "a cat" },
      result: { status: "error", error: { error: "quota exceeded" } },
    });
    expect(rendered.toolError).toBe("quota exceeded");
  });

  test("names an MCP card after its tool so servers stay distinguishable", () => {
    const rendered = renderToolCall({
      type: "mcp",
      args: { providerIdentifier: "context7", toolName: "query-docs", args: { q: "zod" } },
      result: { status: "success", value: { content: [{ text: "docs" }], isError: false } },
    });
    expect(rendered.toolName).toBe("mcp__context7__query-docs");
    expect(rendered.toolTitle).toBe("context7: query-docs");
    expect(rendered.toolArgs).toEqual({ q: "zod" });
    expect(rendered.toolOutput).toBe("docs");
  });

  test("an MCP isError payload lands as an error rather than as output", () => {
    const rendered = renderToolCall({
      type: "mcp",
      args: { toolName: "t" },
      result: { status: "success", value: { content: [{ text: "boom" }], isError: true } },
    });
    expect(rendered.toolError).toBe("boom");
    expect(rendered.toolOutput).toBeUndefined();
  });

  test("a task call reports its sub-agent metadata", () => {
    const rendered = renderToolCall({
      type: "task",
      args: {
        description: "Review",
        prompt: "look at the diff",
        subagentType: { kind: "custom", name: "reviewer" },
      },
      result: {
        status: "success",
        value: { agentId: "agent-1", isBackground: true, backgroundReason: "agentRequest" },
      },
    });
    expect(rendered.subagent).toMatchObject({
      description: "Review",
      subagentType: "reviewer",
      agentId: "agent-1",
      isBackground: true,
    });
    expect(rendered.toolArgs?.subagent_type).toBe("reviewer");
  });

  test("prefers the post-merge todo list from the result", () => {
    const rendered = renderToolCall({
      type: "updateTodos",
      args: { todos: [{ content: "requested", status: "pending" }] },
      result: {
        status: "success",
        value: {
          todos: [
            { content: "merged", status: "inProgress" },
            { content: "done", status: "completed" },
          ],
          totalCount: 2,
        },
      },
    });
    expect(rendered.todos).toEqual([
      { content: "merged", status: "in_progress" },
      { content: "done", status: "completed" },
    ]);
  });

  test("an unknown tool degrades to a plain card instead of throwing", () => {
    const rendered = renderToolCall({ type: "somethingNew", args: { a: 1 } });
    expect(rendered.toolName).toBe("somethingNew");
    expect(rendered.toolArgs).toEqual({ a: 1 });
  });

  test("a malformed call still produces a renderable card", () => {
    expect(renderToolCall(null).toolName).toBe("tool");
    expect(renderToolCall(undefined).toolName).toBe("tool");
  });

  test("flattens an ls directory tree", () => {
    const rendered = renderToolCall({
      type: "ls",
      args: { path: "/w" },
      result: {
        status: "success",
        value: {
          directoryTreeRoot: {
            name: "w",
            children: [{ name: "src", children: [{ name: "a.ts" }] }],
          },
        },
      },
    });
    expect(rendered.toolOutput).toBe("w\n  src\n    a.ts");
  });
});

describe("readTodos", () => {
  test("normalizes the SDK's camelCase status to the renderer's vocabulary", () => {
    expect(readTodos([{ content: "a", status: "inProgress" }])).toEqual([
      { content: "a", status: "in_progress" },
    ]);
  });

  test("drops entries the renderer could not display", () => {
    expect(
      readTodos([
        { content: "keep", status: "pending" },
        { content: "", status: "pending" },
        { content: "bad status", status: "unknowable" },
        "not an object",
      ]),
    ).toEqual([{ content: "keep", status: "pending" }]);
  });

  test("a non-array source is no todos rather than a throw", () => {
    expect(readTodos(undefined)).toEqual([]);
    expect(readTodos({ todos: [] })).toEqual([]);
  });
});
