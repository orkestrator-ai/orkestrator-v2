import { describe, expect, jest, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { itemToParts, stringifyUnknown } from "./index.js";
import type { FileChangeDiffContext } from "./index.js";

jest.setTimeout(30_000);
import type { ThreadItem } from "./codex-item-types.js";
import type { EngineItem } from "./engine/types.js";
import { DEFAULT_MAX_COMMAND_OUTPUT_CHARS } from "./sessions/turn-accumulator.js";

const DUMMY_CWD = "/tmp/test-workspace";
const COMMAND_OUTPUT_TRUNCATION_NOTICE = "\n… output truncated";

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

  test("converts an asynchronous question to a structured transcript part", async () => {
    const item: ThreadItem = {
      id: "ask-1",
      type: "agent_message",
      text: "Which target?",
      delivery: "async",
      questions: [
        { title: "Which target?", options: ["Staging", "Production"] },
        { title: "Any constraints?" },
      ],
    };

    expect(await itemToParts(item, DUMMY_CWD)).toEqual([
      {
        type: "async-question",
        content: "Which target?",
        asyncQuestion: {
          itemId: "ask-1",
          questions: [
            { id: "ask-1:0", title: "Which target?", options: ["Staging", "Production"] },
            { id: "ask-1:1", title: "Any constraints?", options: [] },
          ],
        },
      },
    ]);
  });

  test("converts reasoning to thinking part", async () => {
    const item: ThreadItem = {
      id: "reason-1",
      type: "reasoning",
      text: "Let me think about this...",
    };

    const parts = await itemToParts(item, DUMMY_CWD);

    expect(parts).toEqual([{ type: "thinking", content: "Let me think about this..." }]);
  });

  test("converts a plan to a labelled successful tool invocation", async () => {
    const item: EngineItem = {
      id: "plan-1",
      type: "plan",
      text: "1. Inspect\n2. Implement",
    };

    expect(await itemToParts(item, DUMMY_CWD)).toEqual([
      {
        type: "tool-invocation",
        toolUseId: "plan-1",
        content: "1. Inspect\n2. Implement",
        toolName: "plan",
        toolState: "success",
        toolTitle: "Plan",
        toolOutput: "1. Inspect\n2. Implement",
      },
    ]);
  });

  test("does not render subagent activity or collaboration timeline items", async () => {
    const subagentActivity: EngineItem = {
      id: "activity-1",
      type: "subagent_activity",
      activity: "interacted",
      agent_thread_id: "thread-2",
    };
    const collaborationItem: EngineItem = {
      id: "collab-1",
      type: "collab_tool_call",
      tool: "spawn_agent",
      receiver_thread_ids: ["thread-2"],
      status: "completed",
    };

    expect(await itemToParts(subagentActivity, DUMMY_CWD)).toEqual([]);
    expect(await itemToParts(collaborationItem, DUMMY_CWD)).toEqual([]);
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
        toolUseId: "cmd-1",
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

  test("converts dynamic exec calls to command-labelled tool invocations", async () => {
    const item: EngineItem = {
      id: "dynamic-1",
      type: "dynamic_tool_call",
      namespace: "functions",
      tool: "exec",
      arguments:
        'const r = await tools.exec_command({"cmd":"git status --short","yield_time_ms":10000});',
      content_items: [
        { type: "inputText", text: " M src/example.ts" },
        { type: "inputImage", imageUrl: "data:image/png;base64,abc" },
      ],
      status: "completed",
    };

    expect(await itemToParts(item, DUMMY_CWD)).toEqual([
      {
        type: "tool-invocation",
        toolUseId: "dynamic-1",
        content: "exec",
        toolName: "exec",
        toolArgs: {
          input:
            'const r = await tools.exec_command({"cmd":"git status --short","yield_time_ms":10000});',
          command: "git status --short",
        },
        toolState: "success",
        toolTitle: "functions:exec",
        toolOutput: " M src/example.ts\n[image]",
        toolError: undefined,
      },
    ]);
  });

  test("renders failed dynamic tool output as an error", async () => {
    const item: EngineItem = {
      id: "dynamic-2",
      type: "dynamic_tool_call",
      tool: "exec",
      arguments: "throw new Error('nope')",
      content_items: [{ type: "inputText", text: "nope" }],
      status: "failed",
    };

    expect((await itemToParts(item, DUMMY_CWD))[0]).toMatchObject({
      toolState: "failure",
      toolOutput: undefined,
      toolError: "nope",
      // No namespace, so the title stays the bare tool name.
      toolTitle: "exec",
    });
  });

  test("renders raw multi-file apply_patch calls as per-file edit parts", async () => {
    const item: EngineItem = {
      id: "dynamic-patch",
      type: "dynamic_tool_call",
      tool: "apply_patch",
      arguments: `*** Begin Patch
*** Update File: src/a.ts
@@
-a
+A
*** Add File: src/b.ts
+B
*** End Patch`,
      content_items: [{ type: "inputText", text: "Done!" }],
      status: "completed",
    };

    const parts = await itemToParts(item, DUMMY_CWD);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({
      content: "src/a.ts",
      toolName: "apply_patch",
      toolState: "success",
      toolTitle: "update: src/a.ts",
      toolOutput: "Done!",
      toolDiff: {
        filePath: `${DUMMY_CWD}/src/a.ts`,
        additions: 1,
        deletions: 1,
      },
    });
    expect(parts[1]).toMatchObject({
      content: "src/b.ts",
      toolTitle: "add: src/b.ts",
      toolDiff: { filePath: `${DUMMY_CWD}/src/b.ts` },
    });
  });

  test("reports an unfinished dynamic tool call as pending", async () => {
    const item: EngineItem = {
      id: "dynamic-3",
      type: "dynamic_tool_call",
      tool: "exec",
      arguments: null,
      content_items: [],
      status: "in_progress",
    };

    expect((await itemToParts(item, DUMMY_CWD))[0]).toMatchObject({
      toolState: "pending",
      toolArgs: undefined,
      toolOutput: undefined,
      toolError: undefined,
    });
  });

  test("falls back to a generic error when a failed dynamic call produced no output", async () => {
    const item: EngineItem = {
      id: "dynamic-4",
      type: "dynamic_tool_call",
      tool: "exec",
      arguments: null,
      content_items: [],
      status: "failed",
    };

    expect((await itemToParts(item, DUMMY_CWD))[0]).toMatchObject({
      toolState: "failure",
      toolError: "Tool failed",
    });
  });

  test("summarizes inline media instead of inlining the payload", async () => {
    const item: EngineItem = {
      id: "dynamic-5",
      type: "dynamic_tool_call",
      tool: "exec",
      arguments: null,
      content_items: [
        { type: "inputImage", imageUrl: `data:image/png;base64,${"A".repeat(500_000)}` },
        { type: "inputAudio", audioUrl: "data:audio/wav;base64,AAAA" },
        // A referenceable URL is still useful, so it survives intact.
        { type: "inputImage", imageUrl: "https://example.test/a.png" },
      ],
      status: "completed",
    };

    expect((await itemToParts(item, DUMMY_CWD))[0]!.toolOutput).toBe(
      "[image]\n[audio]\nhttps://example.test/a.png",
    );
  });

  test("stringifies dynamic content entries it does not recognize", async () => {
    const item: EngineItem = {
      id: "dynamic-6",
      type: "dynamic_tool_call",
      tool: "exec",
      arguments: null,
      content_items: [
        { type: "inputText" },
        { type: "somethingElse", value: 1 },
        42,
        null,
        undefined,
        "",
        ["a"],
        { type: "inputImage", imageUrl: 7 },
      ],
      status: "completed",
    };

    expect((await itemToParts(item, DUMMY_CWD))[0]!.toolOutput).toBe(
      [
        JSON.stringify({ type: "inputText" }, null, 2),
        JSON.stringify({ type: "somethingElse", value: 1 }, null, 2),
        "42",
        "null",
        JSON.stringify(["a"], null, 2),
        JSON.stringify({ type: "inputImage", imageUrl: 7 }, null, 2),
      ].join("\n"),
    );
  });

  test("caps oversized dynamic tool output", async () => {
    const item: EngineItem = {
      id: "dynamic-7",
      type: "dynamic_tool_call",
      tool: "exec",
      arguments: null,
      content_items: [{ type: "inputText", text: "x".repeat(400_000) }],
      status: "completed",
    };

    const output = (await itemToParts(item, DUMMY_CWD))[0]!.toolOutput!;
    expect(output.length).toBeLessThanOrEqual(DEFAULT_MAX_COMMAND_OUTPUT_CHARS);
    expect(output.endsWith(COMMAND_OUTPUT_TRUNCATION_NOTICE)).toBe(true);
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
        toolUseId: "search-1",
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

  // File-change rows are built from app-server's own per-change payload. The
  // worktree is never read: by the time a row renders again the file may hold
  // later edits, and a row must not claim them.
  test("renders an update from its supplied hunks, never from the worktree", async () => {
    await withGitWorkspace(async (dir) => {
      const filePath = join(dir, "example.txt");
      writeFileSync(filePath, "unrelated\n", "utf8");
      const context: FileChangeDiffContext = { cache: new Map() };
      const item: ThreadItem = {
        id: "patch-1",
        type: "file_change",
        changes: [{ path: "example.txt", kind: "update", diff: "@@ -1 +1,2 @@\n one\n+two\n" }],
        status: "completed",
      };

      const first = await itemToParts(item, dir, context);
      writeFileSync(filePath, "one\ntwo\nthree\n", "utf8");
      const again = await itemToParts(item, dir);

      expect(first[0]?.toolDiff).toEqual({
        filePath,
        diff: "--- a/example.txt\n+++ b/example.txt\n@@ -1 +1,2 @@\n one\n+two\n",
        additions: 1,
        deletions: 0,
      });
      expect(again[0]?.toolDiff).toEqual(first[0]?.toolDiff);
    });
  });

  test("builds add and delete rows from the supplied file content", async () => {
    const parts = await itemToParts(
      {
        id: "patch-lifecycle",
        type: "file_change",
        changes: [
          { path: "added.txt", kind: "add", diff: "alpha\nbeta\n" },
          { path: "deleted.txt", kind: "delete", diff: "x\ny\nz" },
          { path: "empty.txt", kind: "add", diff: "" },
        ],
        status: "completed",
      },
      DUMMY_CWD,
    );

    expect(parts[0]?.toolDiff).toMatchObject({ additions: 2, deletions: 0 });
    expect(parts[0]?.toolDiff?.diff).toBe(
      "--- /dev/null\n+++ b/added.txt\n@@ -0,0 +1,2 @@\n+alpha\n+beta",
    );
    expect(parts[1]?.toolDiff).toMatchObject({ additions: 0, deletions: 3 });
    expect(parts[1]?.toolDiff?.diff).toContain("--- a/deleted.txt\n+++ /dev/null\n@@ -1,3 +0,0 @@");
    expect(parts[1]?.toolDiff?.diff).toEndWith("-z\n\\ No newline at end of file");
    // An empty new file is a known zero, not an unknown.
    expect(parts[2]?.toolDiff).toMatchObject({ additions: 0, deletions: 0 });
    expect(parts[2]?.toolDiff?.diff).toBeUndefined();
  });

  test("keeps the real patch status on every file row", async () => {
    const states = await Promise.all(
      (["in_progress", "completed", "failed", "declined"] as const).map(async (status) => {
        const parts = await itemToParts(
          {
            id: `patch-${status}`,
            type: "file_change",
            changes: [
              { path: "first.txt", kind: "add", diff: "first\n" },
              { path: "second.txt", kind: "add", diff: "second\n" },
            ],
            status,
          },
          DUMMY_CWD,
        );
        expect(parts).toHaveLength(2);
        return parts.map((part) => part.toolState);
      }),
    );
    // In progress is pending, never folded into success; declined never ran.
    expect(states).toEqual([
      ["pending", "pending"],
      ["success", "success"],
      ["failure", "failure"],
      ["failure", "failure"],
    ]);
  });

  test("returns no invocations for a file change with no changed files", async () => {
    expect(
      await itemToParts(
        {
          id: "patch-empty",
          type: "file_change",
          changes: [],
          status: "completed",
        },
        DUMMY_CWD,
      ),
    ).toEqual([]);
  });

  test("shows a change with no supplied diff by path alone", async () => {
    await withGitWorkspace(async (dir) => {
      const filePath = join(dir, "history.txt");
      writeFileSync(filePath, "base\n", "utf8");
      execFileSync("git", ["add", "history.txt"], { cwd: dir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "ignore" });
      writeFileSync(filePath, "base\nlater edit\n", "utf8");

      // Older history has no payload. Today's disk is not evidence of what
      // that change did, so its counts stay unknown rather than reconstructed.
      const parts = await itemToParts(
        {
          id: "patch-history",
          type: "file_change",
          changes: [
            { path: "history.txt", kind: "update" },
            { path: "missing.txt", kind: "delete" },
          ],
          status: "completed",
        },
        dir,
        { cache: new Map() },
      );

      expect(parts[0]?.toolDiff).toEqual({ filePath });
      expect(parts[1]?.toolDiff).toEqual({ filePath: join(dir, "missing.txt") });
    });
  });

  test("relativizes absolute paths in diff headers and keeps a rename's destination", async () => {
    const cwd = "/workspace/repo";
    const parts = await itemToParts(
      {
        id: "patch-absolute",
        type: "file_change",
        changes: [
          { path: `${cwd}/absolute.txt`, kind: "update", diff: "@@ -1 +1,2 @@\n before\n+after\n" },
          {
            path: `${cwd}/old.ts`,
            kind: "update",
            move_path: `${cwd}/new.ts`,
            diff: "@@ -1 +1 @@\n-a\n+b\n\n\nMoved to: /workspace/repo/new.ts",
          },
          {
            path: `${cwd}/plain-move.ts`,
            kind: "update",
            diff: "\n\nMoved to: /workspace/repo/renamed.ts",
          },
        ],
        status: "completed",
      },
      cwd,
    );

    expect(parts[0]?.toolDiff?.filePath).toBe(`${cwd}/absolute.txt`);
    expect(parts[0]?.toolDiff?.diff).toContain("--- a/absolute.txt\n+++ b/absolute.txt");
    expect(parts[0]?.toolDiff?.diff).toContain("+after");
    // app-server's rename note is not diff content.
    expect(parts[1]?.toolDiff?.diff).toBe("--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-a\n+b\n");
    expect(parts[1]?.toolDiff).toMatchObject({ additions: 1, deletions: 1 });
    // A pure rename changes no lines: a known zero with nothing to show.
    expect(parts[2]?.toolDiff).toMatchObject({ additions: 0, deletions: 0 });
    expect(parts[2]?.toolDiff?.diff).toBeUndefined();
  });

  test("never caches an in-progress diff as the change's result", async () => {
    const context: FileChangeDiffContext = { cache: new Map() };
    const preview = (diff: string, status: "in_progress" | "completed"): ThreadItem => ({
      id: "patch-streaming",
      type: "file_change",
      changes: [{ path: "a.ts", kind: "update", diff }],
      status,
    });

    const early = await itemToParts(
      preview("@@ -1 +1 @@\n-a\n+b\n", "in_progress"),
      DUMMY_CWD,
      context,
    );
    expect(context.cache.size).toBe(0);
    const final = await itemToParts(
      preview("@@ -1 +1,2 @@\n-a\n+b\n+c\n", "completed"),
      DUMMY_CWD,
      context,
    );

    expect(early[0]?.toolDiff).toMatchObject({ additions: 1, deletions: 1 });
    expect(final[0]?.toolDiff).toMatchObject({ additions: 2, deletions: 1 });
    expect(context.cache.size).toBe(1);
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
    expect(part.toolOutput).toBe(
      '{\n  "content": [],\n  "structured_content": {\n    "data": "test"\n  }\n}',
    );
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

    expect(parts).toEqual([
      expect.objectContaining({
        type: "tool-invocation",
        toolUseId: "mcp-pending",
        toolName: "slow_tool",
        toolState: "pending",
        toolTitle: "pending-server:slow_tool",
        toolArgs: { value: 1 },
      }),
    ]);
  });

  test("renders an unknown item type as a generic card rather than dropping it", async () => {
    // A Codex upgrade that adds an item type must not make the turn look like
    // it did less work than it did. The card says what happened without
    // claiming to know what the item contained.
    const item = {
      id: "unknown-1",
      type: "future_type",
      secret: "the user's private prompt",
    } as unknown as ThreadItem;

    const parts = await itemToParts(item, DUMMY_CWD);

    expect(parts).toEqual([
      {
        type: "tool-invocation",
        toolUseId: "unknown-1",
        content: "Codex reported a future_type item this bridge cannot render",
        toolName: "future_type",
        toolState: "success",
        toolTitle: "Unrendered future_type",
      },
    ]);
    // Names only: an item's own fields carry prompts, file contents and command
    // output, and this reaches the renderer and the logs.
    expect(JSON.stringify(parts)).not.toContain("private prompt");
  });

  test("an item with no type at all still produces a card", async () => {
    const parts = await itemToParts({ id: "x" } as unknown as ThreadItem, DUMMY_CWD);
    expect(parts[0]).toMatchObject({ toolName: "unknown" });
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
