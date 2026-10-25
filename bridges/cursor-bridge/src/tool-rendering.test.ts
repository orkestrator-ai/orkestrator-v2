import { describe, expect, test } from "bun:test";
import { MAX_TOOL_ARGUMENT_BYTES, MAX_TOOL_OUTPUT_BYTES, MAX_TOOL_TITLE_BYTES } from "./config.js";
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

  test("names an in-process custom-user-tools call as Orkestrator", () => {
    const rendered = renderToolCall({
      type: "mcp",
      args: {
        providerIdentifier: "custom-user-tools",
        toolName: "launch_environment",
        args: { name: "worker" },
      },
      result: { status: "success", value: { content: [{ text: "created" }], isError: false } },
    });
    expect(rendered.toolName).toBe("mcp__orkestrator__launch_environment");
    expect(rendered.toolTitle).toBe("orkestrator: launch_environment");
    expect(rendered.toolArgs).toEqual({ name: "worker" });
    expect(rendered.toolOutput).toBe("created");
  });

  test("names an in-process research call after its own server", () => {
    const rendered = renderToolCall({
      type: "mcp",
      args: {
        providerIdentifier: "custom-user-tools",
        toolName: "context7__query-docs",
        args: { q: "zod" },
      },
      result: { status: "success", value: { content: [{ text: "docs" }], isError: false } },
    });
    expect(rendered.toolName).toBe("mcp__context7__query-docs");
    expect(rendered.toolTitle).toBe("context7: query-docs");
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

  test("reads the SDK's wrapped MCP text items and names image items", () => {
    const rendered = renderToolCall({
      type: "mcp",
      args: { providerIdentifier: "orkestrator", toolName: "get_artifact_operation" },
      result: {
        status: "success",
        value: {
          content: [
            { text: { text: '{"ok":true}' } },
            { image: { data: "iVBORw0KGgo".repeat(1_000), mimeType: "image/png" } },
          ],
          isError: false,
        },
      },
    });
    expect(rendered.toolOutput).toBe('{"ok":true}\n[image]');
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

  test("createPlan keeps markdown in output and a short title, not escaped args", () => {
    const rendered = renderToolCall({
      type: "createPlan",
      args: {
        name: "Split discovery",
        plan: "# Split discovery\n\nDo the work.",
      },
    });
    expect(rendered.toolTitle).toBe("Split discovery");
    expect(rendered.toolArgs).toEqual({ name: "Split discovery" });
    expect(rendered.toolOutput).toBe("# Split discovery\n\nDo the work.");
  });

  test("createPlan uses the first heading when the tool omitted a name", () => {
    const rendered = renderToolCall({
      type: "createPlan",
      args: { plan: "## Review package\n\nSteps." },
    });
    expect(rendered.toolTitle).toBe("Review package");
    expect(rendered.toolArgs).toBeUndefined();
    expect(rendered.toolOutput).toBe("## Review package\n\nSteps.");
  });

  test("createPlan bounds a provider-supplied name before retaining it", () => {
    const rendered = renderToolCall({
      type: "createPlan",
      args: { name: "n".repeat(MAX_TOOL_TITLE_BYTES * 2), plan: "# Plan" },
    });

    expect(Buffer.byteLength(rendered.toolTitle ?? "")).toBeLessThanOrEqual(MAX_TOOL_TITLE_BYTES);
    expect(Buffer.byteLength(JSON.stringify(rendered.toolArgs))).toBeLessThanOrEqual(
      MAX_TOOL_ARGUMENT_BYTES,
    );
    expect(rendered.toolArgs?.name).toBe(rendered.toolTitle);
  });

  test("createPlan bounds a heading-derived title and its markdown output", () => {
    const rendered = renderToolCall({
      type: "createPlan",
      args: {
        plan: `# ${"h".repeat(MAX_TOOL_OUTPUT_BYTES * 2)}`,
      },
    });

    expect(Buffer.byteLength(rendered.toolTitle ?? "")).toBeLessThanOrEqual(MAX_TOOL_TITLE_BYTES);
    expect(Buffer.byteLength(rendered.toolOutput ?? "")).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_BYTES);
    expect(rendered.toolArgs).toBeUndefined();
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

describe("computer use", () => {
  const actions = [
    { type: "mouseMove", coordinate: { x: 10, y: 20 } },
    { type: "click", button: "left", count: 1 },
    { type: "type", text: "hello" },
    { type: "click", button: "left", count: 2 },
    { type: "key", key: "Enter", stroke: "tap" },
    { type: "screenshot" },
  ];

  test("titles an undescribed batch by its count and first action kinds", () => {
    const rendered = renderToolCall({ type: "computerUse", args: { actions } });
    expect(rendered.toolName).toBe("computerUse");
    expect(rendered.toolTitle).toBe("Computer use · 6 actions (mouseMove, click, type…)");
    expect(rendered.toolArgs).toEqual({ actions });
    expect(rendered.toolDurationMs).toBeUndefined();
    expect(rendered.toolImage).toBeUndefined();
  });

  test("prefers the model's description and reports the log, duration and screenshot", () => {
    const rendered = renderToolCall({
      type: "computerUse",
      args: { actions: [{ type: "screenshot" }], description: "Open the settings pane" },
      result: {
        status: "success",
        value: {
          actionCount: 1,
          durationMs: 840.4,
          settleMs: 200,
          screenshotPath: "/tmp/cu/shot.png",
          log: "screenshot ok\n",
        },
      },
    });
    expect(rendered.toolTitle).toBe("Open the settings pane");
    expect(rendered.toolOutput).toBe("screenshot ok\n");
    expect(rendered.toolDurationMs).toBe(840);
    expect(rendered.toolError).toBeUndefined();
    expect(rendered.toolImage).toEqual({
      filePath: "/tmp/cu/shot.png",
      caption: "Open the settings pane",
      imageSource: "viewed",
    });
  });

  test("summarizes a successful batch that returned no log", () => {
    const rendered = renderToolCall({
      type: "computerUse",
      args: { actions: [{ type: "cursorPosition" }] },
      result: {
        status: "success",
        value: { actionCount: 1, durationMs: 12, cursorPosition: { x: 4, y: 5 } },
      },
    });
    expect(rendered.toolTitle).toBe("Computer use · 1 action (cursorPosition)");
    expect(rendered.toolOutput).toBe("1 action completed · cursor at (4, 5)");
  });

  test("a failure keeps its message, log, duration and screenshot", () => {
    const rendered = renderToolCall({
      type: "computerUse",
      args: { actions },
      result: {
        status: "error",
        error: {
          message: "Accessibility permission denied",
          actionCount: 2,
          durationMs: 31,
          screenshotPath: "/tmp/cu/fail.png",
          log: "moved\nclick refused\n",
        },
      },
    });
    expect(rendered.toolError).toBe("Accessibility permission denied");
    expect(rendered.toolOutput).toBe("moved\nclick refused\n");
    expect(rendered.toolDurationMs).toBe(31);
    expect(rendered.toolImage?.filePath).toBe("/tmp/cu/fail.png");
  });

  test("malformed shapes degrade to a plain card instead of throwing", () => {
    for (const call of [
      { type: "computerUse" },
      { type: "computerUse", args: { actions: "click" } },
      { type: "computerUse", args: { actions: [null, 3, { type: 7 }, {}] } },
      { type: "computerUse", args: {}, result: { status: "error", error: "boom" } },
      { type: "computerUse", args: {}, result: { status: "success", value: "nope" } },
      {
        type: "computerUse",
        args: {},
        result: { status: "success", value: { durationMs: "slow", screenshotPath: 5 } },
      },
    ]) {
      const rendered = renderToolCall(call);
      expect(rendered.toolName).toBe("computerUse");
      expect(rendered.toolTitle?.startsWith("Computer use")).toBe(true);
      expect(rendered.toolDurationMs).toBeUndefined();
      expect(rendered.toolImage).toBeUndefined();
    }
    expect(renderToolCall({ type: "computerUse", args: { actions: [null, {}] } }).toolTitle).toBe(
      "Computer use · 2 actions",
    );
    expect(
      renderToolCall({ type: "computerUse", args: {}, result: { status: "error", error: "boom" } })
        .toolError,
    ).toBe("boom");
  });

  test("bounds a long title", () => {
    const rendered = renderToolCall({
      type: "computerUse",
      args: { actions: [], description: "x".repeat(MAX_TOOL_TITLE_BYTES * 2) },
    });
    expect(Buffer.byteLength(rendered.toolTitle ?? "")).toBeLessThanOrEqual(MAX_TOOL_TITLE_BYTES);
  });
});

describe("tool durations", () => {
  test("a shell result reports its execution time", () => {
    const rendered = renderToolCall({
      type: "shell",
      args: { command: "sleep 1" },
      result: {
        status: "success",
        value: { exitCode: 0, signal: "", stdout: "", stderr: "", executionTime: 1003 },
      },
    });
    expect(rendered.toolDurationMs).toBe(1003);
  });

  test("the SDK's zero fill-in for an unmeasured shell call is not a duration", () => {
    const rendered = renderToolCall({
      type: "shell",
      args: { command: "ls" },
      result: {
        status: "success",
        value: { exitCode: 0, signal: "", stdout: "", stderr: "", executionTime: 0 },
      },
    });
    expect(rendered.toolDurationMs).toBeUndefined();
  });

  test("a running call has no duration", () => {
    expect(renderToolCall({ type: "shell", args: { command: "ls" } }).toolDurationMs).toBe(
      undefined,
    );
  });

  test("a foreground task reports its duration and the model it asked for", () => {
    const rendered = renderToolCall({
      type: "task",
      args: { description: "Review", prompt: "p", model: "gpt-5.5-high" },
      result: {
        status: "success",
        value: { isBackground: false, backgroundReason: "unspecified", durationMs: 4200 },
      },
    });
    expect(rendered.toolDurationMs).toBe(4200);
    expect(rendered.subagent?.modelId).toBe("gpt-5.5-high");
  });

  test("a background launch's duration is not shown as the child's runtime", () => {
    const rendered = renderToolCall({
      type: "task",
      args: { description: "Review", prompt: "p" },
      result: {
        status: "success",
        value: { isBackground: true, backgroundReason: "agentRequest", durationMs: 90 },
      },
    });
    expect(rendered.toolDurationMs).toBeUndefined();
    expect(rendered.subagent?.modelId).toBeUndefined();
  });
});
