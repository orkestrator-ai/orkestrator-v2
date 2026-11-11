import { describe, expect, test } from "bun:test";
import {
  OPENCODE2_INTERRUPTED_TEXT,
  normalizeOpenCode2Groups,
  normalizeOpenCode2Message,
  normalizeOpenCode2Transcript,
} from "./transcript.js";
import { openCode2ToolPart } from "./transcript-tools.js";
import type { OpenCode2Message } from "./types.js";

type Part = Record<string, unknown>;
const rows = (messages: unknown[], onUnknown?: (type: string) => void) =>
  normalizeOpenCode2Transcript(messages as OpenCode2Message[], onUnknown);
const partsOf = (row: Record<string, unknown> | undefined) => row!.parts as Part[];

describe("normalizeOpenCode2Transcript", () => {
  test("user and assistant rows become shared rows; a succeeded idle row is dropped", () => {
    const result = rows([
      { id: "u1", type: "user", text: "hello", time: { created: 1_700_000_000_000 } },
      {
        id: "a1",
        type: "assistant",
        model: { providerID: "openrouter", id: "anthropic/claude", variant: "high" },
        content: [
          { type: "reasoning", text: "thinking" },
          { type: "reasoning", text: "   " },
          { type: "text", text: "Hi" },
          {
            type: "tool",
            id: "t1",
            name: "shell",
            state: {
              status: "completed",
              input: { command: "ls" },
              content: [{ type: "text", text: "a\nb" }],
            },
            time: { created: 10, ran: 20, completed: 50 },
          },
          {
            type: "tool",
            id: "t2",
            name: "edit",
            state: { status: "running", input: {}, metadata: {} },
          },
          { type: "future-kind", text: "?" },
        ],
        time: { created: 1_700_000_000_001 },
      },
      { id: "i1", type: "idle", outcome: "succeeded", time: { created: 2 } },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: "u1",
      role: "user",
      content: "hello",
      parts: [{ type: "text", content: "hello" }],
      createdAt: new Date(1_700_000_000_000).toISOString(),
    });
    expect(result[1]).toMatchObject({
      id: "a1",
      role: "assistant",
      content: "Hi",
      modelId: "openrouter/anthropic/claude",
      reasoningId: "high",
    });
    expect(partsOf(result[1])).toMatchObject([
      { type: "thinking", content: "thinking" },
      { type: "text", content: "Hi" },
      {
        type: "tool-invocation",
        toolName: "shell",
        toolUseId: "t1",
        toolArgs: { command: "ls" },
        toolState: "success",
        toolOutput: "a\nb",
        toolDurationMs: 30,
      },
      { type: "tool-invocation", toolName: "edit", toolState: "pending" },
    ]);
  });

  test("every non-response row kind has a declared rendering, and an unknown one is reported", () => {
    const unknown: string[] = [];
    const result = rows(
      [
        { id: "s1", type: "synthetic", text: "background job finished", time: { created: 3 } },
        {
          id: "s2",
          type: "system",
          text: "SECRET INSTRUCTIONS",
          description: "Instructions updated: AGENTS.md",
          time: { created: 3 },
        },
        { id: "s3", type: "skill", name: "review", text: "…", time: { created: 3 } },
        { id: "s4", type: "agent-switched", agent: "plan", time: { created: 3 } },
        {
          id: "s5",
          type: "model-switched",
          model: { providerID: "openai", id: "gpt-5" },
          time: { created: 3 },
        },
        { id: "s6", type: "location-switched", location: {}, time: { created: 3 } },
        { id: "s7", type: "hologram", time: { created: 3 } },
      ],
      (type) => unknown.push(type),
    );
    expect(result.map((row) => row.content)).toEqual([
      "background job finished",
      "Instructions updated: AGENTS.md",
      "Skill loaded: review",
      "Agent: plan",
      "Model: openai/gpt-5",
    ]);
    expect(result.every((row) => row.role === "system")).toBe(true);
    expect(partsOf(result[0])[0]).toMatchObject({ type: "status", severity: "info" });
    // The instruction text itself never reaches the transcript.
    expect(JSON.stringify(result)).not.toContain("SECRET INSTRUCTIONS");
    expect(unknown).toEqual(["hologram"]);
  });

  test("a finished background shell shows the command and the output it emitted", () => {
    const command = "sleep 20; echo a > out; echo DONE-1";
    const result = rows([
      {
        id: "s1",
        type: "synthetic",
        description: command,
        text: `<shell id="sh_1" state="completed" command="${command}">\nDONE-1\n\n</shell>`,
        metadata: {
          source: "shell",
          shellID: "sh_1",
          state: "completed",
          truncated: false,
          exit: 0,
        },
        time: { created: 3 },
      },
      {
        id: "s2",
        type: "synthetic",
        description: "false",
        text: `<shell id="sh_2" state="failed" command="false">\n</shell>`,
        metadata: { source: "shell", state: "failed", truncated: true, exit: 1 },
        time: { created: 4 },
      },
      {
        id: "s3",
        type: "synthetic",
        description: "yes | head",
        text: `<shell id="sh_3" state="completed" command="yes | head">\ny\ny\n</shell>`,
        metadata: { source: "shell", state: "completed", truncated: true, exit: 0 },
        time: { created: 5 },
      },
      // Not the 2.2.6 shell shape: the description alone, as before.
      {
        id: "s4",
        type: "synthetic",
        description: "Shell note",
        text: "unwrapped text",
        metadata: { source: "shell" },
        time: { created: 6 },
      },
      {
        id: "s5",
        type: "synthetic",
        description: "Attached a file",
        text: `<shell id="x">\nnot a shell report\n</shell>`,
        metadata: { source: "file" },
        time: { created: 7 },
      },
    ]);
    expect(result.map((row) => row.content)).toEqual([
      `Background command completed: ${command}\nDONE-1`,
      "Background command failed (exit 1): false",
      "Background command completed: yes | head\ny\ny\n(output truncated)",
      "Shell note",
      "Attached a file",
    ]);
    expect(result.every((row) => row.role === "system")).toBe(true);
    expect(partsOf(result[0])[0]).toMatchObject({
      type: "status",
      content: `Background command completed: ${command}\nDONE-1`,
    });
  });

  test("a failed run reads as one error and a stopped run as an interruption", () => {
    const result = rows([
      {
        id: "a1",
        type: "assistant",
        model: { providerID: "p", id: "m" },
        content: [],
        error: { type: "APIError", message: "rate limited" },
        time: { created: 1, completed: 2 },
      },
      {
        id: "i1",
        type: "idle",
        outcome: "failed",
        error: { message: "rate limited" },
        time: { created: 3 },
      },
      { id: "u2", type: "user", text: "again", time: { created: 4 } },
      {
        id: "i2",
        type: "idle",
        outcome: "failed",
        error: { message: "provider down" },
        time: { created: 5 },
      },
      { id: "i3", type: "idle", outcome: "interrupted", time: { created: 6 } },
    ]);
    expect(result.map((row) => [row.id, row.content])).toEqual([
      ["a1", ""],
      ["error-opencode-a1", "Model request failed: rate limited"],
      ["u2", "again"],
      ["error-opencode-i2", "provider down"],
      ["i3", OPENCODE2_INTERRUPTED_TEXT],
    ]);
    expect(result[1]).toMatchObject({ role: "assistant", modelId: "p/m" });
  });

  test("a failed response groups with its error so a page never splits them", () => {
    const groups = normalizeOpenCode2Groups([
      { id: "a1", type: "assistant", content: [], error: { message: "x" }, time: { created: 1 } },
      { id: "i1", type: "idle", outcome: "succeeded", time: { created: 2 } },
    ] as OpenCode2Message[]);
    expect(groups.map((group) => group.map((row) => row.id))).toEqual([
      ["a1", "error-opencode-a1"],
      [],
    ]);
  });

  test("shell, compaction and retry rows", () => {
    const result = rows([
      {
        id: "sh",
        type: "shell",
        shellID: "x",
        command: "false",
        status: "exited",
        exit: 1,
        output: { output: "nope", cursor: 0, size: 4, truncated: false },
        time: { created: 10, completed: 40 },
      },
      {
        id: "c1",
        type: "compaction",
        status: "completed",
        reason: "auto",
        summary: "Earlier: did X",
        time: { created: 1 },
      },
      {
        id: "c2",
        type: "compaction",
        status: "failed",
        reason: "manual",
        error: { message: "too big" },
        time: { created: 1 },
      },
      {
        id: "a1",
        type: "assistant",
        content: [{ type: "text", text: "working" }],
        retry: { attempt: 2, at: 5, error: { message: "overloaded" } },
        time: { created: 1 },
      },
    ]);
    expect(partsOf(result[0])[0]).toMatchObject({
      type: "tool-invocation",
      toolName: "shell",
      toolArgs: { command: "false" },
      toolState: "failure",
      toolOutput: "nope",
      toolError: "Exit 1",
      toolDurationMs: 30,
    });
    expect(partsOf(result[1])[0]).toEqual({ type: "compaction", content: "Earlier: did X" });
    expect(result[2]).toMatchObject({ role: "system", content: "Compaction failed: too big" });
    expect(partsOf(result[3])[1]).toMatchObject({
      type: "retry",
      content: "overloaded",
      retryAttempt: 2,
    });
  });

  test("a row without a usable time or content degrades instead of throwing", () => {
    expect(
      normalizeOpenCode2Message({ id: "a", type: "assistant", time: {} } as OpenCode2Message),
    ).toBeNull();
    expect(
      normalizeOpenCode2Message({ id: "u", type: "user", text: "x" } as OpenCode2Message),
    ).toMatchObject({
      createdAt: "1970-01-01T00:00:00.000Z",
    });
    expect(rows([null, "x", { type: "user" }, { id: "n" }])).toEqual([]);
  });

  test("user attachments are shown by name", () => {
    const [row] = rows([
      {
        id: "u",
        type: "user",
        text: "see",
        files: [
          { uri: "file:///w/a.png", name: "a.png", mime: "image/png" },
          { uri: "file:///w/b.txt", mime: "text/plain" },
        ],
        time: { created: 1 },
      },
    ]);
    expect(partsOf(row).slice(1)).toEqual([
      {
        type: "image",
        content: "a.png",
        imageSource: "attachment",
        mime: "image/png",
        fileUrl: "file:///w/a.png",
      },
      { type: "file", content: "file:///w/b.txt", mime: "text/plain", fileUrl: "file:///w/b.txt" },
    ]);
  });
});

describe("openCode2ToolPart", () => {
  test("an edit carries its file diff from metadata", () => {
    const part = openCode2ToolPart({
      type: "tool",
      id: "e1",
      name: "edit",
      state: {
        status: "completed",
        input: { path: "src/a.ts", oldString: "a\n", newString: "b\n" },
        content: [{ type: "text", text: "Edited src/a.ts (1 replacement)" }],
        metadata: {
          files: [
            {
              file: "src/a.ts",
              patch: "@@ -1 +1 @@\n-a\n+b\n",
              status: "modified",
              additions: 1,
              deletions: 1,
            },
          ],
        },
      },
      time: { created: 1 },
    });
    expect(part).toMatchObject({
      type: "tool-invocation",
      toolName: "edit",
      toolState: "success",
      toolDiff: { filePath: "src/a.ts", additions: 1, deletions: 1, before: "a\n", after: "b\n" },
    });
  });

  test("a failed call shows its error and a streaming call its parsed input when whole", () => {
    expect(
      openCode2ToolPart({
        type: "tool",
        id: "x",
        name: "read",
        state: {
          status: "error",
          input: { path: "/nope" },
          error: { type: "ToolFailure", message: "File not found" },
        },
        time: { created: 1 },
      }),
    ).toMatchObject({ toolState: "failure", toolError: "File not found" });
    expect(
      openCode2ToolPart({
        type: "tool",
        id: "y",
        name: "read",
        state: { status: "streaming", input: '{"path":"/a"}' },
        time: { created: 1 },
      }),
    ).toMatchObject({ toolState: "pending", toolArgs: { path: "/a" } });
    expect(
      openCode2ToolPart({
        type: "tool",
        id: "y",
        name: "read",
        state: { status: "streaming", input: '{"pa' },
        time: { created: 1 },
      }),
    ).not.toHaveProperty("toolArgs");
  });

  test("a sub-agent call becomes a sub-agent card, active while a background child runs", () => {
    const input = {
      agent: "explore",
      description: "Find the bug",
      prompt: "Look",
      background: true,
    };
    expect(
      openCode2ToolPart({
        type: "tool",
        id: "s",
        name: "subagent",
        state: {
          status: "completed",
          input,
          content: [{ type: "text", text: "working in the background" }],
          metadata: { sessionID: "ses_child", status: "running" },
        },
        time: { created: 1 },
      }),
    ).toMatchObject({
      type: "subagent",
      content: "Find the bug",
      subagentId: "ses_child",
      subagentName: "Find the bug",
      subagentRole: "explore",
      subagentPrompt: "Look",
      agentState: "active",
      toolState: "success",
    });
    expect(
      openCode2ToolPart({
        type: "tool",
        id: "s",
        name: "subagent",
        state: {
          status: "completed",
          input: { ...input, background: false },
          content: [
            {
              type: "text",
              text: '<subagent sessionID="ses_c2" state="completed">\nok\n</subagent>',
            },
          ],
        },
        time: { created: 1 },
      }),
    ).toMatchObject({ subagentId: "ses_c2", agentState: "finished" });
  });

  test("bodies are bounded, oversized input is not inlined, and an unknown tool is a plain card", () => {
    const part = openCode2ToolPart({
      type: "tool",
      id: "w",
      name: "plugin_thing",
      state: {
        status: "completed",
        input: { body: "x".repeat(70_000) },
        content: [
          { type: "text", text: "y".repeat(250_000) },
          { type: "file", uri: "data:image/png;base64,AAA", mime: "image/png" },
        ],
      },
      time: { created: 1 },
    })!;
    expect(part.type).toBe("tool-invocation");
    expect(part.toolArgs).toBeUndefined();
    expect((part.toolOutput as string).length).toBeLessThan(200_100);
    expect(openCode2ToolPart({ type: "tool", name: 3, state: "nonsense" })).toMatchObject({
      toolName: "Unknown tool",
    });
    const withFile = openCode2ToolPart({
      type: "tool",
      id: "f",
      name: "image",
      state: {
        status: "completed",
        input: {},
        content: [{ type: "file", uri: "data:image/png;base64,AAA", mime: "image/png" }],
      },
    })!;
    expect(withFile.toolOutput).toBe("[image/png: inline data]");
  });
});
