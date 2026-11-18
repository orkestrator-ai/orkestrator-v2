import { describe, expect, test } from "bun:test";
import {
  OPENCODE2_INTERRUPTED_TEXT,
  normalizeOpenCode2Groups,
  normalizeOpenCode2Message,
  normalizeOpenCode2Transcript,
  openCode2BackgroundReport,
  openCode2BackgroundShellReport,
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

  test("a timed-out command's report shows its output, whatever its command line holds (2.3.1)", () => {
    // 2.3.1 writes the command into the tag unescaped; a long test run that
    // timed out often spans lines and quotes.
    const commands = [`echo "it's" && grep -r 'a"b' .`, "bun test \\\n  --parallel=4"];
    const result = rows(
      commands.map((command, index) => ({
        id: `t${index}`,
        type: "synthetic",
        description: command,
        text: `<shell id="shl_${index}" state="completed" command="${command}">\nPASS ${index}\n</shell>`,
        metadata: {
          source: "shell",
          shellID: `shl_${index}`,
          jobID: `shl_${index}`,
          state: "completed",
          exit: 0,
        },
        time: { created: index + 1 },
      })),
    );
    expect(result.map((row) => row.content)).toEqual(
      commands.map((command, index) => `Background command completed: ${command}\nPASS ${index}`),
    );
  });

  test("a command a stop terminated reads as stopped, not as a bare error tag (2.3.1)", () => {
    const result = rows([
      {
        id: "x1",
        type: "synthetic",
        description: "sleep 60",
        text: '<shell id="shl_9" state="error" command="sleep 60">\nShell.NotFoundError\n</shell>',
        metadata: { source: "shell", shellID: "shl_9", jobID: "shl_9", state: "error" },
        time: { created: 1 },
      },
      {
        id: "x2",
        type: "synthetic",
        description: "false",
        text: '<shell id="shl_8" state="error" command="false">\nspawn failed\n</shell>',
        metadata: { source: "shell", shellID: "shl_8", jobID: "shl_8", state: "error" },
        time: { created: 2 },
      },
    ]);
    expect(result.map((row) => row.content)).toEqual([
      "Background command stopped: sleep 60",
      "Background command error: false\nspawn failed",
    ]);
  });

  test("background reports: a shell's with a job id and a sub-agent's, never a user's command", () => {
    const shell = (metadata: Record<string, unknown>) => ({
      type: "synthetic",
      text: '<shell id="shl_1" state="completed" command="ls">\nx\n</shell>',
      metadata: { source: "shell", shellID: "shl_1", state: "completed", ...metadata },
    });
    expect(openCode2BackgroundShellReport(shell({ jobID: "shl_1" }))).toBe(true);
    expect(openCode2BackgroundReport(shell({ jobID: "shl_1" }))).toBe(true);
    // A command the user ran themselves wakes nothing: no job.
    expect(openCode2BackgroundShellReport(shell({}))).toBe(false);
    expect(openCode2BackgroundReport(shell({}))).toBe(false);
    expect(openCode2BackgroundShellReport({ ...shell({ jobID: "shl_1" }), type: "user" })).toBe(
      false,
    );
    expect(
      openCode2BackgroundReport({
        type: "synthetic",
        text: '<subagent sessionID="ses_c" state="completed">\nok\n</subagent>',
        metadata: { source: "subagent", childID: "ses_c", state: "completed" },
      }),
    ).toBe(true);
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

/** A 2.3.0 `subagent` call: it returns at once with its child still running. */
function launchRow(id: string, callId: string, childId: string, completedAt = 1_000) {
  return {
    id,
    type: "assistant",
    content: [
      {
        type: "tool",
        id: callId,
        name: "subagent",
        state: {
          status: "completed",
          input: { agent: "general", description: "probe child", prompt: "Look" },
          content: [
            {
              type: "text",
              text: `The subagent is working in the background (sessionID: ${childId}).`,
            },
          ],
          metadata: { sessionID: childId, status: "running", truncated: false },
        },
        time: { created: completedAt - 10, ran: completedAt - 5, completed: completedAt },
      },
    ],
    time: { created: completedAt - 20 },
  };
}

/** The `<subagent>` report 2.3.0 delivers to the parent each time the child goes idle. */
function reportRow(id: string, childId: string, state: string, body: string) {
  return {
    id,
    type: "synthetic",
    description: "probe child",
    metadata: { source: "subagent", childID: childId, agent: "General", state },
    text: `<subagent sessionID="${childId}" state="${state}" description="probe child">\n${body}\n</subagent>`,
    time: { created: 5_000 },
  };
}

describe("background sub-agent reports (OpenCode 2.3.0)", () => {
  const cardOf = (result: Record<string, unknown>[], callId: string) =>
    result.flatMap((row) => partsOf(row)).find((part) => part.toolUseId === callId);

  test("a report folds onto its launch: the card takes its answer and settles, the row shows nothing", () => {
    const result = rows([
      { id: "u1", type: "user", text: "go", time: { created: 1 } },
      launchRow("a1", "call_1", "ses_child"),
      { id: "i1", type: "idle", outcome: "succeeded", time: { created: 2 } },
      reportRow("r1", "ses_child", "completed", "found it"),
      {
        id: "a2",
        type: "assistant",
        content: [{ type: "text", text: "done" }],
        time: { created: 6 },
      },
    ]);
    expect(result.map((row) => row.id)).toEqual(["u1", "a1", "a2"]);
    expect(cardOf(result, "call_1")).toMatchObject({
      type: "subagent",
      subagentId: "ses_child",
      agentState: "finished",
      toolState: "success",
      toolOutput: "found it",
    });
  });

  test("an error or a cancel fails the card with the report's text", () => {
    for (const [state, body] of [
      ["error", "model refused"],
      ["cancelled", "Subagent cancelled"],
    ] as const) {
      const result = rows([
        launchRow("a1", "call_1", "ses_c"),
        reportRow("r1", "ses_c", state, body),
      ]);
      expect(cardOf(result, "call_1")).toMatchObject({ agentState: "failed", toolError: body });
    }
  });

  test("a child still running background work of its own stays active, and its next report settles it", () => {
    const still = "partial\n\nBackground work still running:\n- shell (sh_1): sleep 9";
    const first = rows([
      launchRow("a1", "call_1", "ses_c"),
      reportRow("r1", "ses_c", "completed", still),
    ]);
    expect(cardOf(first, "call_1")).toMatchObject({ agentState: "active", toolOutput: still });
    const second = rows([
      launchRow("a1", "call_1", "ses_c"),
      reportRow("r1", "ses_c", "completed", still),
      reportRow("r2", "ses_c", "completed", "all done"),
    ]);
    expect(cardOf(second, "call_1")).toMatchObject({
      agentState: "finished",
      toolOutput: "all done",
    });
  });

  test("a follow-up that joins a running child is settled by the same report", () => {
    const result = rows([
      launchRow("a1", "call_1", "ses_c"),
      launchRow("a2", "call_2", "ses_c"),
      reportRow("r1", "ses_c", "completed", "both"),
      launchRow("a3", "call_3", "ses_c"),
    ]);
    expect(cardOf(result, "call_1")).toMatchObject({ agentState: "finished", toolOutput: "both" });
    expect(cardOf(result, "call_2")).toMatchObject({ agentState: "finished", toolOutput: "both" });
    // A later follow-up has no report yet; with no running sessions to read it reads Ended.
    expect(cardOf(result, "call_3")).toMatchObject({ agentState: "ended" });
  });

  test("a launch with no report reads by the running sessions at the head, Ended elsewhere", () => {
    const messages = [launchRow("a1", "call_1", "ses_c", 1_000)] as unknown as OpenCode2Message[];
    const at = (liveSessions: ReadonlySet<string> | "unknown" | undefined, now: number) =>
      cardOf(
        normalizeOpenCode2Transcript(messages, undefined, {
          ...(liveSessions ? { liveSessions } : {}),
          now,
        }),
        "call_1",
      )?.agentState;
    expect(at(new Set(["ses_c"]), 60_000)).toBe("active");
    // Just launched: admitted before it starts draining.
    expect(at(new Set(), 2_000)).toBe("active");
    // Not running long after its launch (a restarted server did not resume it).
    expect(at(new Set(), 60_000)).toBe("ended");
    expect(at("unknown", 60_000)).toBe("active");
    expect(at(undefined, 2_000)).toBe("ended");
  });

  test("a report whose launch is not among the rows read keeps a row of its own", () => {
    const result = rows([reportRow("r1", "ses_c", "error", "it broke")]);
    expect(result).toHaveLength(1);
    expect(partsOf(result[0])[0]).toMatchObject({
      type: "status",
      severity: "error",
      content: "Sub-agent failed: probe child\nit broke",
    });
    // Groups stay aligned with their input rows.
    const groups = normalizeOpenCode2Groups([
      launchRow("a1", "call_1", "ses_c"),
      reportRow("r1", "ses_c", "completed", "ok"),
    ] as unknown as OpenCode2Message[]);
    expect(groups.map((group) => group.length)).toEqual([1, 0]);
  });

  test("a 2.2.6 foreground call settles from its own output and is never folded", () => {
    const result = rows([
      {
        id: "a1",
        type: "assistant",
        content: [
          {
            type: "tool",
            id: "call_f",
            name: "subagent",
            state: {
              status: "completed",
              input: { agent: "general", description: "fg", prompt: "x" },
              content: [
                {
                  type: "text",
                  text: '<subagent sessionID="ses_f" state="completed">\nok\n</subagent>',
                },
              ],
              metadata: { sessionID: "ses_f", status: "completed" },
            },
          },
        ],
        time: { created: 1 },
      },
    ]);
    expect(cardOf(result, "call_f")).toMatchObject({ agentState: "finished" });
  });
});
