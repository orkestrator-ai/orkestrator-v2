import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { itemToParts, stringifyUnknown } from "./index.js";
import type { FileChangeDiffContext } from "./index.js";
import type { ThreadItem } from "@openai/codex-sdk";

const DUMMY_CWD = "/tmp/test-workspace";

async function withGitWorkspace<T>(callback: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "codex-bridge-item-to-parts-"));
  try {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: dir,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "Test User"], {
      cwd: dir,
      stdio: "ignore",
    });
    return await callback(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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

  test("keeps apply_patch diffs scoped to each file_change invocation", async () => {
    await withGitWorkspace(async (dir) => {
      const filePath = join(dir, "example.txt");
      writeFileSync(filePath, "one\n", "utf8");
      execFileSync("git", ["add", "example.txt"], { cwd: dir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "initial"], {
        cwd: dir,
        stdio: "ignore",
      });

      const context: FileChangeDiffContext = {
        baselines: new Map(),
        cache: new Map(),
      };
      const firstItem: ThreadItem = {
        id: "patch-1",
        type: "file_change",
        changes: [{ path: "example.txt", kind: "update" }],
        status: "completed",
      };
      const secondItem: ThreadItem = {
        id: "patch-2",
        type: "file_change",
        changes: [{ path: "example.txt", kind: "update" }],
        status: "completed",
      };

      writeFileSync(filePath, "one\ntwo\n", "utf8");
      const firstParts = await itemToParts(firstItem, dir, context);
      writeFileSync(filePath, "one\ntwo\nthree\n", "utf8");
      const secondParts = await itemToParts(secondItem, dir, context);
      const firstPartsAfterSecondPatch = await itemToParts(firstItem, dir, context);

      expect(firstParts[0]?.toolDiff?.additions).toBe(1);
      expect(firstParts[0]?.toolDiff?.deletions).toBe(0);
      expect(firstParts[0]?.toolDiff?.diff).toContain("+two");
      expect(secondParts[0]?.toolDiff?.additions).toBe(1);
      expect(secondParts[0]?.toolDiff?.deletions).toBe(0);
      expect(secondParts[0]?.toolDiff?.diff).toContain("+three");
      expect(firstPartsAfterSecondPatch[0]?.toolDiff).toEqual(firstParts[0]?.toolDiff);
    });
  });

  test("captures add, update, and delete diffs for the same path over time", async () => {
    await withGitWorkspace(async (dir) => {
      const filePath = join(dir, "lifecycle.txt");
      const context: FileChangeDiffContext = {
        baselines: new Map(),
        cache: new Map(),
      };

      writeFileSync(filePath, "alpha\nbeta\n", "utf8");
      const addParts = await itemToParts({
        id: "patch-add",
        type: "file_change",
        changes: [{ path: "lifecycle.txt", kind: "add" }],
        status: "completed",
      }, dir, context);

      writeFileSync(filePath, "alpha\nbeta\ngamma\n", "utf8");
      const updateParts = await itemToParts({
        id: "patch-update",
        type: "file_change",
        changes: [{ path: "lifecycle.txt", kind: "update" }],
        status: "completed",
      }, dir, context);

      unlinkSync(filePath);
      const deleteParts = await itemToParts({
        id: "patch-delete",
        type: "file_change",
        changes: [{ path: "lifecycle.txt", kind: "delete" }],
        status: "completed",
      }, dir, context);

      expect(addParts[0]?.toolDiff?.additions).toBe(2);
      expect(addParts[0]?.toolDiff?.deletions).toBe(0);
      expect(addParts[0]?.toolDiff?.before).toBeUndefined();
      expect(addParts[0]?.toolDiff?.after).toBe("alpha\nbeta\n");
      expect(addParts[0]?.toolDiff?.diff).toContain("+alpha");
      expect(updateParts[0]?.toolDiff?.additions).toBe(1);
      expect(updateParts[0]?.toolDiff?.deletions).toBe(0);
      expect(updateParts[0]?.toolDiff?.diff).toContain("+gamma");
      expect(deleteParts[0]?.toolDiff?.additions).toBe(0);
      expect(deleteParts[0]?.toolDiff?.deletions).toBe(3);
      expect(deleteParts[0]?.toolDiff?.after).toBeUndefined();
      expect(deleteParts[0]?.toolDiff?.diff).toContain("-gamma");
    });
  });

  test("captures multi-file patch diffs and marks failed file changes", async () => {
    await withGitWorkspace(async (dir) => {
      writeFileSync(join(dir, "first.txt"), "first\n", "utf8");
      writeFileSync(join(dir, "second.txt"), "second\n", "utf8");

      const parts = await itemToParts({
        id: "patch-multi",
        type: "file_change",
        changes: [
          { path: "first.txt", kind: "add" },
          { path: "second.txt", kind: "add" },
        ],
        status: "failed",
      }, dir, {
        baselines: new Map(),
        cache: new Map(),
      });

      expect(parts).toHaveLength(2);
      expect(parts[0]?.toolState).toBe("failure");
      expect(parts[0]?.toolDiff?.diff).toContain("+first");
      expect(parts[1]?.toolState).toBe("failure");
      expect(parts[1]?.toolDiff?.diff).toContain("+second");
    });
  });

  test("handles missing file changes without throwing", async () => {
    await withGitWorkspace(async (dir) => {
      const parts = await itemToParts({
        id: "patch-missing",
        type: "file_change",
        changes: [{ path: "missing.txt", kind: "delete" }],
        status: "completed",
      }, dir, {
        baselines: new Map(),
        cache: new Map(),
      });

      expect(parts[0]?.toolDiff).toMatchObject({
        additions: 0,
        deletions: 0,
        before: undefined,
        after: undefined,
        diff: undefined,
      });
    });
  });

  test("normalizes absolute paths in apply_patch diff headers", async () => {
    await withGitWorkspace(async (dir) => {
      const filePath = join(dir, "absolute.txt");
      writeFileSync(filePath, "before\n", "utf8");
      execFileSync("git", ["add", "absolute.txt"], { cwd: dir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "initial"], {
        cwd: dir,
        stdio: "ignore",
      });

      writeFileSync(filePath, "before\nafter\n", "utf8");
      const parts = await itemToParts({
        id: "patch-absolute",
        type: "file_change",
        changes: [{ path: filePath, kind: "update" }],
        status: "completed",
      }, dir, {
        baselines: new Map(),
        cache: new Map(),
      });

      expect(parts[0]?.toolDiff?.filePath).toBe(filePath);
      expect(parts[0]?.toolDiff?.diff).toContain("--- a/absolute.txt");
      expect(parts[0]?.toolDiff?.diff).toContain("+++ b/absolute.txt");
      expect(parts[0]?.toolDiff?.diff).toContain("+after");
    });
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

  test("converts an in-progress mcp_tool_call to a pending invocation", async () => {
    const item = {
      id: "mcp-pending",
      type: "mcp_tool_call" as const,
      server: "pending-server",
      tool: "slow_tool",
      arguments: { value: 1 },
      status: "in_progress" as const,
    };

    const parts = await itemToParts(item, DUMMY_CWD);

    expect(parts).toEqual([expect.objectContaining({
      type: "tool-invocation",
      toolName: "slow_tool",
      toolState: "pending",
      toolTitle: "pending-server:slow_tool",
      toolArgs: { value: 1 },
    })]);
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
