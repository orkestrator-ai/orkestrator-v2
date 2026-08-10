import { describe, expect, test } from "bun:test";
import { toPipelineTranscript } from "./pipeline-transcript";

const FALLBACK = "2026-07-29T00:00:00.000Z";

describe("toPipelineTranscript", () => {
  test("hides the initial pipeline handoff and starts with the agent output", () => {
    const handoff = `<orkestrator-handoff format="json-v2">
review context that remains available to the agent
</orkestrator-handoff>

Address every review issue.`;

    for (const [agent, firstMessage] of [
      ["codex", {
        id: "codex-user",
        role: "user",
        content: handoff,
        parts: [{ type: "text", content: handoff }],
      }],
      ["claude", {
        id: "claude-user",
        role: "user",
        content: handoff,
        parts: [{ type: "text", content: handoff }],
      }],
      ["opencode", {
        info: { id: "opencode-user", role: "user", time: { created: 1_800_000_000_000 } },
        parts: [{ type: "text", text: handoff }],
      }],
    ] as const) {
      const transcript = toPipelineTranscript(
        [
          null,
          firstMessage,
          {
            id: `${agent}-assistant`,
            role: "assistant",
            content: "Starting with the useful output",
            parts: [{ type: "text", content: "Starting with the useful output" }],
          },
        ],
        agent,
        FALLBACK,
      );

      expect(transcript.map((message) => message.content)).toEqual([
        "Starting with the useful output",
      ]);
    }
  });

  test("does not hide later or non-user handoff-shaped messages", () => {
    const handoff = `<orkestrator-handoff format="json-v2">
quoted context
</orkestrator-handoff>`;
    const transcript = toPipelineTranscript(
      [
        { id: "first", role: "user", content: "ordinary prompt" },
        { id: "later", role: "user", content: handoff },
        { id: "assistant", role: "assistant", content: handoff },
      ],
      "codex",
      FALLBACK,
    );

    expect(transcript.map((message) => message.id)).toEqual([
      "first",
      "later",
      "assistant",
    ]);
  });

  test("renders bridge messages as native messages with their parts intact", () => {
    const transcript = toPipelineTranscript(
      [{
        id: "message-1",
        role: "assistant",
        content: "Ran the tests",
        createdAt: "2026-07-29T00:01:00.000Z",
        modelId: "gpt-5-codex",
        parts: [
          { type: "text", content: "Ran the tests" },
          {
            type: "tool-invocation",
            content: "shell",
            toolName: "shell",
            toolArgs: { command: "bun test" },
            toolState: "success",
            toolOutput: "33 pass",
          },
        ],
      }],
      "codex",
      FALLBACK,
    );

    expect(transcript).toHaveLength(1);
    expect(transcript[0]).toMatchObject({
      id: "message-1",
      role: "assistant",
      createdAt: "2026-07-29T00:01:00.000Z",
      modelId: "gpt-5-codex",
    });
    expect(transcript[0]!.parts.map((part) => part.type)).toEqual([
      "text",
      "tool-invocation",
    ]);
    expect(transcript[0]!.parts[1]).toMatchObject({
      toolName: "shell",
      toolArgs: { command: "bun test" },
      toolOutput: "33 pass",
    });
  });

  test("groups Claude child tools under the Task that spawned them", () => {
    const transcript = toPipelineTranscript(
      [{
        id: "message-1",
        role: "assistant",
        content: "",
        timestamp: "2026-07-29T00:01:00.000Z",
        parts: [
          {
            type: "tool-invocation",
            toolName: "Task",
            toolUseId: "task-1",
            toolArgs: { description: "Audit the diff" },
          },
          {
            type: "tool-invocation",
            toolName: "Bash",
            parentTaskUseId: "task-1",
            toolArgs: { command: "git diff" },
          },
        ],
      }],
      "claude",
      FALLBACK,
    );

    expect(transcript).toHaveLength(1);
    const [part] = transcript[0]!.parts;
    expect(part?.type).toBe("task-group");
    expect(part?.type === "task-group" && part.childTools).toHaveLength(1);
    // Claude records the message time as `timestamp`; the native model reads
    // `createdAt`, and a missing one would render as an invalid date.
    expect(transcript[0]!.createdAt).toBe("2026-07-29T00:01:00.000Z");
  });

  test("reads OpenCode's info/parts envelope", () => {
    const transcript = toPipelineTranscript(
      [{
        info: {
          id: "message-1",
          role: "assistant",
          time: { created: 1_800_000_000_000 },
        },
        parts: [{ type: "text", text: "All criteria pass" }],
      }],
      "opencode",
      FALLBACK,
    );

    expect(transcript).toHaveLength(1);
    expect(transcript[0]!.content).toBe("All criteria pass");
    expect(transcript[0]!.parts[0]).toMatchObject({
      type: "text",
      content: "All criteria pass",
    });
  });

  test("drops entries and parts it cannot understand instead of rendering them", () => {
    const transcript = toPipelineTranscript(
      [
        null,
        42,
        "text",
        {},
        { role: "assistant", content: "   ", parts: [] },
        {
          id: "message-1",
          role: "assistant",
          content: "kept",
          parts: [
            { type: "mystery-part", content: "ignored" },
            null,
            { content: "typeless" },
            { type: "text", content: "kept" },
          ],
        },
      ],
      "codex",
      FALLBACK,
    );

    expect(transcript).toHaveLength(1);
    expect(transcript[0]!.parts).toHaveLength(1);
    expect(transcript[0]!.parts[0]).toMatchObject({ type: "text", content: "kept" });
  });

  test("replaces collection fields the renderer iterates when they are malformed", () => {
    // A persisted snapshot from an older build can carry any shape at all, and
    // the renderer maps over these without checking.
    const transcript = toPipelineTranscript(
      [{
        id: "message-1",
        role: "assistant",
        content: "",
        parts: [
          {
            type: "subagent",
            content: "reviewer",
            subagentActions: "not-an-array",
          },
          {
            type: "tool-invocation",
            toolName: "TaskCreate",
            taskSnapshot: { items: "not-an-array" },
          },
          {
            type: "tool-invocation",
            toolName: "Read",
            toolArgs: "not-a-record",
          },
        ],
      }],
      "codex",
      FALLBACK,
    );

    const parts = transcript[0]!.parts;
    expect(parts[0]).toMatchObject({ type: "subagent", subagentActions: [] });
    expect(parts[1]!.taskSnapshot).toBeUndefined();
    expect(parts[2]!.toolArgs).toBeUndefined();
  });

  test("drops empty groups and unanchored task groups", () => {
    const transcript = toPipelineTranscript(
      [{
        id: "message-1",
        role: "assistant",
        content: "kept",
        parts: [
          { type: "tool-group", content: "", parts: [] },
          { type: "agent-group", content: "", parts: [{ type: "text", content: "x" }] },
          { type: "task-group", content: "", task: { type: "text", content: "x" } },
          { type: "text", content: "kept" },
        ],
      }],
      "codex",
      FALLBACK,
    );

    expect(transcript[0]!.parts.map((part) => part.type)).toEqual(["text"]);
  });

  test("falls back to the stage start time when a message carries none", () => {
    const transcript = toPipelineTranscript(
      [{ id: "message-1", role: "assistant", content: "no timestamp" }],
      "codex",
      FALLBACK,
    );

    expect(transcript[0]!.createdAt).toBe(FALLBACK);
  });

  test("keeps the grouped part types it is handed", () => {
    const transcript = toPipelineTranscript(
      [{
        id: "message-1",
        role: "assistant",
        content: "",
        parts: [
          {
            type: "tool-group",
            content: "",
            parts: [
              { type: "tool-invocation", toolName: "Read", content: "Read" },
              { type: "tool-invocation", toolName: "Grep", content: "Grep" },
            ],
          },
          {
            type: "agent-group",
            content: "",
            parts: [
              { type: "subagent", content: "reviewer", subagentName: "reviewer" },
              {
                type: "task-group",
                content: "",
                task: { type: "tool-invocation", toolName: "Task", content: "Task" },
                childTools: [
                  { type: "tool-invocation", toolName: "Bash", content: "Bash" },
                ],
              },
            ],
          },
        ],
      }],
      "codex",
      FALLBACK,
    );

    const [group, agents] = transcript[0]!.parts;
    expect(group?.type === "tool-group" && group.parts.map((p) => p.toolName))
      .toEqual(["Read", "Grep"]);
    expect(agents?.type === "agent-group" && agents.parts.map((p) => p.type))
      .toEqual(["subagent", "task-group"]);
  });

  test("rebuilds a subagent's own actions rather than trusting them", () => {
    const transcript = toPipelineTranscript(
      [{
        id: "message-1",
        role: "assistant",
        content: "",
        parts: [{
          type: "subagent",
          content: "reviewer",
          subagentId: "agent-1",
          subagentName: "reviewer",
          subagentRole: "reviewer",
          subagentPrompt: "Audit the diff",
          subagentActionCount: 2,
          agentState: "finished",
          subagentActions: [
            { type: "tool-invocation", toolName: "Read", content: "Read" },
            { type: "mystery", content: "dropped" },
          ],
        }],
      }],
      "codex",
      FALLBACK,
    );

    const [part] = transcript[0]!.parts;
    expect(part).toMatchObject({
      type: "subagent",
      subagentId: "agent-1",
      subagentName: "reviewer",
      subagentRole: "reviewer",
      subagentPrompt: "Audit the diff",
      subagentActionCount: 2,
      agentState: "finished",
    });
    // The unreadable action is dropped; the readable one survives.
    expect(part?.type === "subagent" && part.subagentActions?.map((a) => a.type))
      .toEqual(["tool-invocation"]);
  });

  test("keeps the roles the renderer styles differently", () => {
    const transcript = toPipelineTranscript(
      [
        { id: "a", role: "user", content: "build it" },
        { id: "b", role: "system", content: "context compacted" },
        { id: "c", role: "narrator", content: "who?" },
      ],
      "codex",
      FALLBACK,
    );

    // An unknown role becomes an assistant row rather than being dropped: the
    // text is real even when the label is not.
    expect(transcript.map((message) => message.role))
      .toEqual(["user", "system", "assistant"]);
  });

  test("gives a message with no id a stable, position-derived one", () => {
    const entries = [
      { role: "assistant", content: "first" },
      { role: "assistant", content: "second" },
    ];

    // `computeItemKey` keys Virtuoso on this, and the adapter re-runs on every
    // backend push, so a value that changed per call would remount the row.
    const first = toPipelineTranscript(entries, "codex", FALLBACK);
    const second = toPipelineTranscript(entries, "codex", FALLBACK);
    expect(first.map((message) => message.id))
      .toEqual(["pipeline-message-0", "pipeline-message-1"]);
    expect(second.map((message) => message.id))
      .toEqual(first.map((message) => message.id));
  });

  test("carries the scalar tool metadata the renderer reads", () => {
    const transcript = toPipelineTranscript(
      [{
        id: "message-1",
        role: "assistant",
        content: "",
        turnId: "turn-7",
        parts: [{
          type: "tool-invocation",
          content: "Edit",
          toolName: "Edit",
          toolState: "success",
          toolUseId: "use-1",
          toolUseCount: 3,
          tokenCount: 1024,
          tokenCountText: "1.0k tokens",
          agentUsageDisplay: "token-only",
          isMcpTool: true,
          mcpServerName: "orkestrator",
          _messageUuid: "uuid-1",
          backgroundTask: { id: "bg-1", description: "dev server", status: "running" },
          toolDiff: { filePath: "src/a.ts", diff: "@@", additions: 2, deletions: 1 },
        }],
      }],
      "codex",
      FALLBACK,
    );

    expect(transcript[0]).toMatchObject({ turnId: "turn-7" });
    expect(transcript[0]!.parts[0]).toMatchObject({
      toolUseId: "use-1",
      toolUseCount: 3,
      tokenCount: 1024,
      tokenCountText: "1.0k tokens",
      agentUsageDisplay: "token-only",
      isMcpTool: true,
      mcpServerName: "orkestrator",
      // Claude records a part's identity as `_messageUuid`.
      sourcePartId: "uuid-1",
      backgroundTask: { id: "bg-1", description: "dev server", status: "running" },
      toolDiff: { filePath: "src/a.ts", diff: "@@", additions: 2, deletions: 1 },
    });
  });

  test("drops enum and numeric fields it does not recognise", () => {
    const transcript = toPipelineTranscript(
      [{
        id: "message-1",
        role: "assistant",
        content: "",
        parts: [{
          type: "tool-invocation",
          content: "Edit",
          toolName: "Edit",
          toolState: "exploded",
          agentState: "confused",
          toolUseCount: Number.NaN,
          tokenCount: Number.POSITIVE_INFINITY,
          isMcpTool: "yes",
          backgroundTask: { description: "no id" },
        }],
      }],
      "codex",
      FALLBACK,
    );

    const [part] = transcript[0]!.parts;
    expect(part!.toolState).toBeUndefined();
    expect(part!.agentState).toBeUndefined();
    expect(part!.toolUseCount).toBeUndefined();
    expect(part!.tokenCount).toBeUndefined();
    expect(part!.isMcpTool).toBeUndefined();
    // A background task with no id cannot be joined to anything.
    expect(part!.backgroundTask).toBeUndefined();
  });

  test("rebuilds a diff field by field and drops one with nothing usable", () => {
    // `EditToolPart` calls `.split()` on filePath, diff, before and after.
    const transcript = toPipelineTranscript(
      [{
        id: "message-1",
        role: "assistant",
        content: "",
        parts: [
          {
            type: "tool-invocation",
            toolName: "Edit",
            content: "Edit",
            toolDiff: { filePath: 42, diff: 7, before: 1, additions: "many" },
          },
          {
            type: "tool-invocation",
            toolName: "Edit",
            content: "Edit",
            toolDiff: { filePath: "src/a.ts", before: 1 },
          },
        ],
      }],
      "codex",
      FALLBACK,
    );

    const parts = transcript[0]!.parts;
    expect(parts[0]!.toolDiff).toBeUndefined();
    expect(parts[1]!.toolDiff).toMatchObject({ filePath: "src/a.ts" });
    expect(parts[1]!.toolDiff?.before).toBeUndefined();
  });

  test("rebuilds a task snapshot and drops one with an unreadable item", () => {
    // `TodoToolPart` dereferences id, subject and status on every element.
    const transcript = toPipelineTranscript(
      [{
        id: "message-1",
        role: "assistant",
        content: "",
        parts: [
          {
            type: "tool-invocation",
            toolName: "TaskList",
            content: "TaskList",
            taskSnapshot: {
              items: [
                { id: "t1", subject: "Write the adapter", status: "completed" },
                { id: "t2", subject: "", status: "pending" },
              ],
              changedTaskId: "t2",
              complete: true,
              truncated: 3,
            },
          },
          {
            type: "tool-invocation",
            toolName: "TaskUpdate",
            content: "TaskUpdate",
            taskSnapshot: { items: [null], complete: true },
          },
          {
            type: "tool-invocation",
            toolName: "TaskGet",
            content: "TaskGet",
            taskSnapshot: {
              items: [{ id: 1, subject: {}, status: "nope" }],
              complete: true,
            },
          },
        ],
      }],
      "codex",
      FALLBACK,
    );

    const parts = transcript[0]!.parts;
    expect(parts[0]!.taskSnapshot).toEqual({
      items: [
        { id: "t1", subject: "Write the adapter", status: "completed" },
        { id: "t2", subject: "", status: "pending" },
      ],
      changedTaskId: "t2",
      complete: true,
      truncated: 3,
    });
    // One unreadable item drops the whole list rather than shortening it.
    expect(parts[1]!.taskSnapshot).toBeUndefined();
    expect(parts[2]!.taskSnapshot).toBeUndefined();
  });

  test("refuses to call a snapshot complete unless it said so", () => {
    const transcript = toPipelineTranscript(
      [{
        id: "message-1",
        role: "assistant",
        content: "",
        parts: [{
          type: "tool-invocation",
          toolName: "TaskList",
          content: "TaskList",
          taskSnapshot: { items: [{ id: "t1", subject: "x", status: "pending" }] },
        }],
      }],
      "codex",
      FALLBACK,
    );

    expect(transcript[0]!.parts[0]!.taskSnapshot?.complete).toBe(false);
  });

  test("splits a Claude turn at a long pause, as the Claude tab does", () => {
    const transcript = toPipelineTranscript(
      [{
        id: "m1",
        role: "assistant",
        content: "",
        timestamp: "2026-07-29T00:00:00.000Z",
        parts: [
          {
            type: "text",
            content: "starting",
            timestamp: "2026-07-29T00:00:00.000Z",
            _messageUuid: "uuid-a",
          },
          {
            type: "tool-invocation",
            toolName: "Bash",
            content: "Bash",
            toolArgs: { command: "bun test" },
            timestamp: "2026-07-29T00:01:00.000Z",
          },
          {
            type: "text",
            content: "done",
            timestamp: "2026-07-29T00:30:00.000Z",
          },
        ],
      }],
      "claude",
      FALLBACK,
    );

    // The Claude adapter reads `timestamp`/`_messageUuid`, not the native
    // `createdAt`/`sourcePartId` this module validates into. Without the names
    // being put back, every part arrives untimestamped and this is one row.
    expect(transcript.map((message) => message.id))
      .toEqual(["m1", "m1:text-block:2"]);
    expect(transcript[1]!.createdAt).toBe("2026-07-29T00:30:00.000Z");
    expect(transcript[0]!.parts[0]).toMatchObject({ sourcePartId: "uuid-a" });
  });

  test("drops a Claude message left with nothing to render", () => {
    const transcript = toPipelineTranscript(
      [
        { id: "m1", role: "assistant", content: "", parts: [{ type: "tool-group", parts: [] }] },
        { id: "m2", role: "assistant", content: "kept" },
      ],
      "claude",
      FALLBACK,
    );

    expect(transcript.map((message) => message.id)).toEqual(["m2"]);
  });

  test("anchors an OpenCode message with no id or time to its position", () => {
    const entries = [{
      info: { role: "assistant" },
      parts: [{ type: "text", text: "building" }],
    }];

    const first = toPipelineTranscript(entries, "opencode", FALLBACK);
    const second = toPipelineTranscript(entries, "opencode", FALLBACK);

    // OpenCode's normalizer mints a UUID and stamps "now" for these; both would
    // change on every backend push and remount the row.
    expect(first[0]!.id).toBe("pipeline-message-0");
    expect(first[0]!.createdAt).toBe(FALLBACK);
    expect(second[0]).toMatchObject({
      id: first[0]!.id,
      createdAt: first[0]!.createdAt,
    });
  });

  test("survives an OpenCode timestamp that cannot be a date", () => {
    // `new Date(value).toISOString()` throws a RangeError past the time clip,
    // and this runs during render — a throw takes the whole tab down.
    const transcript = toPipelineTranscript(
      [
        {
          info: { id: "m1", role: "assistant", time: { created: 1e18 } },
          parts: [{ type: "text", text: "still readable" }],
        },
        {
          info: { id: "m2", role: "assistant", time: { created: Number.NaN } },
          parts: [{ type: "text", text: "also readable" }],
        },
      ],
      "opencode",
      FALLBACK,
    );

    expect(transcript.map((message) => message.id)).toEqual(["m1", "m2"]);
    expect(transcript.map((message) => message.createdAt))
      .toEqual([FALLBACK, FALLBACK]);
    expect(transcript[0]!.content).toBe("still readable");
  });

  test("drops an OpenCode entry with nothing to render", () => {
    const transcript = toPipelineTranscript(
      [
        { info: { id: "m1", role: "assistant", time: { created: 1 } }, parts: [] },
        { info: { id: "m2", role: "assistant", time: { created: 2 } }, parts: [{ type: "text", text: "kept" }] },
      ],
      "opencode",
      FALLBACK,
    );

    expect(transcript.map((message) => message.id)).toEqual(["m2"]);
  });

  test("routes on the envelope, not the pipeline's recorded agent", () => {
    // A pipeline whose agent was recorded as codex can still hold an OpenCode
    // snapshot, and vice versa, so each entry is detected on its own shape.
    const transcript = toPipelineTranscript(
      [
        {
          info: { id: "m1", role: "assistant", time: { created: 1 } },
          parts: [{ type: "text", text: "from opencode" }],
        },
        { id: "m2", role: "assistant", content: "from a bridge" },
      ],
      "codex",
      FALLBACK,
    );

    expect(transcript.map((message) => message.content))
      .toEqual(["from opencode", "from a bridge"]);
  });

  test("treats a non-record info as a flat message", () => {
    const transcript = toPipelineTranscript(
      [{ id: "m1", info: "not-a-record", role: "assistant", content: "kept" }],
      "codex",
      FALLBACK,
    );

    expect(transcript).toHaveLength(1);
    expect(transcript[0]).toMatchObject({ id: "m1", content: "kept" });
  });

  test("returns nothing for a stage with no messages at all", () => {
    expect(toPipelineTranscript(undefined, "codex", FALLBACK)).toEqual([]);
    expect(toPipelineTranscript([], "claude", FALLBACK)).toEqual([]);
  });

  test("keeps a background task's status only when the renderer knows it", () => {
    const transcript = toPipelineTranscript(
      [{
        id: "message-1",
        role: "assistant",
        content: "",
        parts: [
          {
            type: "tool-invocation",
            toolName: "Bash",
            content: "Bash",
            backgroundTask: { id: "bg-1", description: "dev server", status: "killed" },
          },
          {
            type: "tool-invocation",
            toolName: "Bash",
            content: "Bash",
            // `NativeBackgroundTaskStatus` has no such member. Casting it
            // through would put a value in the part that its own type says
            // cannot exist, for the next exhaustive consumer to trip over.
            backgroundTask: { id: "bg-2", status: "cancelled" },
          },
          {
            type: "tool-invocation",
            toolName: "Bash",
            content: "Bash",
            backgroundTask: { id: "bg-3", status: 7 },
          },
        ],
      }],
      "codex",
      FALLBACK,
    );

    const parts = transcript[0]!.parts;
    expect(parts[0]!.backgroundTask)
      .toEqual({ id: "bg-1", description: "dev server", status: "killed" });
    // The task itself survives; only the unreadable status is dropped.
    expect(parts[1]!.backgroundTask).toEqual({ id: "bg-2", description: undefined });
    expect(parts[2]!.backgroundTask).toEqual({ id: "bg-3", description: undefined });
  });

  test("accepts every task status spelling the protocol's own registry accepts", () => {
    const transcript = toPipelineTranscript(
      [{
        id: "message-1",
        role: "assistant",
        content: "",
        parts: [{
          type: "tool-invocation",
          toolName: "TaskList",
          content: "TaskList",
          taskSnapshot: {
            items: [
              { id: "t1", subject: "a", status: "in progress" },
              { id: "t2", subject: "b", status: "In-Progress" },
              { id: "t3", subject: "c", status: "completed" },
            ],
            complete: true,
          },
        }],
      }],
      "codex",
      FALLBACK,
    );

    // The vocabulary is the protocol's, not a copy kept here: a snapshot the
    // registry would have accepted must not be dropped on its way to the tab.
    expect(transcript[0]!.parts[0]!.taskSnapshot?.items.map((item) => item.status))
      .toEqual(["in_progress", "in_progress", "completed"]);
  });

  test("carries the part fields the renderer needs to place a row", () => {
    const transcript = toPipelineTranscript(
      [{
        id: "message-1",
        role: "assistant",
        content: "",
        parts: [
          {
            type: "tool-invocation",
            toolName: "Bash",
            content: "Bash",
            toolTitle: "Run the suite",
            parentTaskUseId: "task-1",
            sourceMessageId: "source-1",
          },
          {
            type: "file",
            content: "/workspace/shot.png",
            fileUrl: "/workspace/shot.png",
          },
        ],
      }],
      "codex",
      FALLBACK,
    );

    const parts = transcript[0]!.parts;
    // `parentTaskUseId` is what groups a tool under the Task that spawned it,
    // and `fileUrl` is what makes an image an image rather than a path.
    expect(parts[0]).toMatchObject({
      toolTitle: "Run the suite",
      parentTaskUseId: "task-1",
      sourceMessageId: "source-1",
    });
    expect(parts[1]).toMatchObject({
      type: "file",
      fileUrl: "/workspace/shot.png",
    });
  });

  test("keeps the model badge on a Claude message", () => {
    const transcript = toPipelineTranscript(
      [{
        id: "m1",
        role: "assistant",
        content: "done",
        modelId: "claude-opus-5",
      }],
      "claude",
      FALLBACK,
    );

    expect(transcript[0]).toMatchObject({ id: "m1", modelId: "claude-opus-5" });
  });

  test("keeps a task group whose child tools are unreadable", () => {
    const transcript = toPipelineTranscript(
      [{
        id: "message-1",
        role: "assistant",
        content: "",
        parts: [{
          type: "task-group",
          content: "",
          task: { type: "tool-invocation", toolName: "Task", content: "Task" },
          childTools: "not-an-array",
        }],
      }],
      "codex",
      FALLBACK,
    );

    const [part] = transcript[0]!.parts;
    // The Task itself is still worth showing; only its children are lost, and
    // the renderer maps over `childTools`, so it must be an array either way.
    expect(part?.type).toBe("task-group");
    expect(part?.type === "task-group" && part.childTools).toEqual([]);
  });

  test("drops the Claude part types its adapter has no renderer for", () => {
    const transcript = toPipelineTranscript(
      [{
        id: "m1",
        role: "assistant",
        content: "",
        parts: [
          {
            type: "tool-group",
            content: "",
            parts: [{ type: "tool-invocation", toolName: "Read", content: "Read" }],
          },
          { type: "subagent", content: "reviewer", subagentName: "reviewer" },
          { type: "text", content: "kept" },
        ],
      }],
      "claude",
      FALLBACK,
    );

    // Claude parts are grouped by its own adapter from flat tool calls, so a
    // pre-grouped part is a shape it cannot read. Dropping it here matches what
    // `normalizeClaudePart` does with it, rather than relying on that.
    expect(transcript[0]!.parts.map((part) => part.type)).toEqual(["text"]);
  });

  test("survives an OpenCode timestamp below the time clip", () => {
    const transcript = toPipelineTranscript(
      [{
        info: { id: "m1", role: "assistant", time: { created: -1e18 } },
        parts: [{ type: "text", text: "still readable" }],
      }],
      "opencode",
      FALLBACK,
    );

    // `Math.abs` is what makes this the same case as a far-future timestamp;
    // a bare upper-bound check would let this one through to the RangeError.
    expect(transcript[0]).toMatchObject({ id: "m1", createdAt: FALLBACK });
  });

  test("reads an OpenCode entry whose time is not a record at all", () => {
    const transcript = toPipelineTranscript(
      [{
        info: { id: "m1", role: "assistant", time: 1_800_000_000_000 },
        parts: [{ type: "text", text: "still readable" }],
      }],
      "opencode",
      FALLBACK,
    );

    expect(transcript[0]).toMatchObject({
      id: "m1",
      content: "still readable",
      createdAt: FALLBACK,
    });
  });

  test("keeps message order across mixed shapes", () => {
    const transcript = toPipelineTranscript(
      [
        { id: "first", role: "user", content: "build it" },
        {
          info: { id: "second", role: "assistant", time: { created: 1 } },
          parts: [{ type: "text", text: "building" }],
        },
        { id: "third", role: "assistant", content: "done" },
      ],
      "codex",
      FALLBACK,
    );

    expect(transcript.map((message) => message.id)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  test("renders a muted, bounded auto-decline history entry without an answer", () => {
    const transcript = toPipelineTranscript(
      [{ id: "provider-message", role: "assistant", content: "Continuing safely" }],
      "codex",
      FALLBACK,
      [{
        id: "interaction-1",
        provider: "codex",
        kind: "question",
        phase: "build",
        requestedAt: 1,
        resolvedAt: 2,
        outcome: "auto-declined-headless",
        title: "Choose an implementation",
        body: "A decision was requested.",
        questions: [{
          prompt: "Which approach?",
          options: ["Conservative", "Expansive"],
        }],
      }],
    );

    const history = transcript.find(
      (message) => message.id === "pipeline-interaction:interaction-1",
    )!;
    expect(history.id).toBe("pipeline-interaction:interaction-1");
    expect(history.role).toBe("system");
    expect(history.content).toContain("codex question during build");
    expect(history.content).toContain("Outcome: auto-declined-headless");
    expect(history.content).toContain("No answer was fabricated");
    expect(history.content).toContain("Conservative, Expansive");
  });

  test("appends multiple interaction entries in their persisted order", () => {
    const transcript = toPipelineTranscript(
      [],
      "claude",
      FALLBACK,
      [
        {
          id: "interaction-1",
          provider: "claude",
          kind: "question",
          phase: "build",
          requestedAt: 1,
          resolvedAt: 2,
          outcome: "auto-declined-headless",
          title: "First choice",
          questions: [],
        },
        {
          id: "interaction-2",
          provider: "claude",
          kind: "mcp-form",
          phase: "build",
          requestedAt: 3,
          resolvedAt: 4,
          outcome: "auto-declined-headless",
          title: "Second choice",
          questions: [],
        },
      ],
    );

    expect(transcript.map((message) => message.id)).toEqual([
      "pipeline-interaction:interaction-1",
      "pipeline-interaction:interaction-2",
    ]);
    expect(transcript[0]!.content).toContain("First choice");
    expect(transcript[1]!.content).toContain("Second choice");
  });

  test("leaves an empty provider transcript empty when there is no interaction history", () => {
    expect(toPipelineTranscript([], "codex", FALLBACK, [])).toEqual([]);
    expect(toPipelineTranscript(undefined, "codex", FALLBACK)).toEqual([]);
  });

  test("timestamps an interaction from its own resolution time", () => {
    const resolvedAt = Date.parse("2026-07-29T00:04:00.000Z");
    const [history] = toPipelineTranscript(
      [],
      "codex",
      FALLBACK,
      [{
        id: "in-range",
        provider: "codex",
        kind: "question",
        phase: "build",
        requestedAt: resolvedAt - 1_000,
        resolvedAt,
        outcome: "auto-declined-headless",
        title: "Choose safely",
        questions: [],
      }],
    );

    // The in-range branch of the numeric guard: the entry is placed at the
    // moment it was resolved, which is what the time merge below sorts on.
    expect(history!.createdAt).toBe(new Date(resolvedAt).toISOString());
  });

  test("omits the options line for a question that offered none", () => {
    const [history] = toPipelineTranscript(
      [],
      "codex",
      FALLBACK,
      [{
        id: "free-text",
        provider: "codex",
        kind: "question",
        phase: "build",
        requestedAt: 1,
        resolvedAt: 2,
        outcome: "auto-declined-headless",
        title: "Describe the approach",
        questions: [{ prompt: "How should the agent proceed?", options: [] }],
      }],
    );

    expect(history!.content).toContain("How should the agent proceed?");
    expect(history!.content).not.toContain("Offered options:");
  });

  test("places an interaction's body above the questions it introduces", () => {
    const [history] = toPipelineTranscript(
      [],
      "codex",
      FALLBACK,
      [{
        id: "with-body",
        provider: "codex",
        kind: "question",
        phase: "build",
        requestedAt: 1,
        resolvedAt: 2,
        outcome: "auto-declined-headless",
        title: "Choose an implementation",
        body: "A decision was requested.",
        questions: [{ prompt: "Which approach?", options: ["Conservative"] }],
      }],
    );

    // The body is the provider's framing of the questions, so it reads as
    // nonsense underneath them.
    expect(history!.content).toContain(
      "A decision was requested.\n\nWhich approach?\nOffered options: Conservative",
    );
  });

  test("joins every question of one interaction into the same entry", () => {
    const [history] = toPipelineTranscript(
      [],
      "codex",
      FALLBACK,
      [{
        id: "multi-question",
        provider: "codex",
        kind: "mcp-form",
        phase: "build",
        requestedAt: 1,
        resolvedAt: 2,
        outcome: "auto-declined-headless",
        title: "Fill in the form",
        questions: [
          { prompt: "Which branch?", options: [] },
          { prompt: "Which reviewer?", options: [] },
          { prompt: "Which milestone?", options: [] },
        ],
      }],
    );

    expect(history!.content).toContain(
      "Which branch?\n\nWhich reviewer?\n\nWhich milestone?",
    );
  });

  test("renders an interaction as one text part carrying the whole entry", () => {
    const [history] = toPipelineTranscript(
      [],
      "codex",
      FALLBACK,
      [{
        id: "single-part",
        provider: "codex",
        kind: "question",
        phase: "build",
        requestedAt: 1,
        resolvedAt: 2,
        outcome: "auto-declined-headless",
        title: "Choose safely",
        body: "A decision was requested.",
        questions: [{ prompt: "Which approach?", options: ["Conservative"] }],
      }],
    );

    // `hasRenderableContent` and the row renderer both read `parts`; a part that
    // disagreed with `content` would show a different entry from the one the
    // search index and the copy affordance work from.
    expect(history!.parts).toEqual([
      { type: "text", content: history!.content },
    ]);
  });

  test("places an interaction beside the work it interrupted", () => {
    const transcript = toPipelineTranscript(
      [
        {
          id: "before",
          role: "assistant",
          content: "Started the build",
          createdAt: "2026-07-29T00:01:00.000Z",
        },
        {
          id: "after",
          role: "assistant",
          content: "Continued safely",
          createdAt: "2026-07-29T00:03:00.000Z",
        },
      ],
      "codex",
      FALLBACK,
      [{
        id: "mid-stage",
        provider: "codex",
        kind: "question",
        phase: "build",
        requestedAt: Date.parse("2026-07-29T00:01:30.000Z"),
        resolvedAt: Date.parse("2026-07-29T00:02:00.000Z"),
        outcome: "auto-declined-headless",
        title: "Choose an implementation",
        questions: [],
      }],
    );

    // Appended instead, the decline would sit below a message stamped a minute
    // after it, reading as though the stage had finished before it happened.
    expect(transcript.map((message) => message.id)).toEqual([
      "before",
      "pipeline-interaction:mid-stage",
      "after",
    ]);
  });

  test("keeps a message with an unreadable timestamp where it was written", () => {
    const transcript = toPipelineTranscript(
      [
        {
          id: "first",
          role: "assistant",
          content: "first",
          createdAt: "2026-07-29T00:05:00.000Z",
        },
        { id: "second", role: "assistant", content: "second", createdAt: "not-a-time" },
        {
          id: "third",
          role: "assistant",
          content: "third",
          createdAt: "2026-07-29T00:06:00.000Z",
        },
      ],
      "codex",
      FALLBACK,
      [{
        id: "last",
        provider: "codex",
        kind: "question",
        phase: "build",
        requestedAt: 1,
        resolvedAt: Date.parse("2026-07-29T00:07:00.000Z"),
        outcome: "auto-declined-headless",
        title: "Choose safely",
        questions: [],
      }],
    );

    // Sorting the unreadable one on a parsed NaN would send it to one end of
    // the stage; it inherits the position of the message before it instead.
    expect(transcript.map((message) => message.id)).toEqual([
      "first",
      "second",
      "third",
      "pipeline-interaction:last",
    ]);
  });

  test("clips each interaction field to its own budget", () => {
    const [history] = toPipelineTranscript(
      [],
      "codex",
      FALLBACK,
      [{
        id: "oversized",
        provider: "codex",
        kind: "question",
        phase: "build",
        requestedAt: 1,
        resolvedAt: 2,
        outcome: "auto-declined-headless",
        title: "T".repeat(600),
        body: "B".repeat(2_000),
        questions: [{ prompt: "P".repeat(600), options: ["O".repeat(200)] }],
      }],
    );

    // The protocol permits 16 KB a field, and this renders as one centred
    // italic block with no expand affordance, so the caps are the only guard.
    expect(history!.content).toContain(`${"T".repeat(511)}…`);
    expect(history!.content).not.toContain("T".repeat(512));
    expect(history!.content).toContain(`${"B".repeat(1_023)}…`);
    expect(history!.content).not.toContain("B".repeat(1_024));
    expect(history!.content).toContain(`${"P".repeat(511)}…`);
    expect(history!.content).toContain(`Offered options: ${"O".repeat(127)}…`);
  });

  test("drops the questions and options past the counts it will render", () => {
    const [history] = toPipelineTranscript(
      [],
      "codex",
      FALLBACK,
      [{
        id: "too-many",
        provider: "codex",
        kind: "mcp-form",
        phase: "build",
        requestedAt: 1,
        resolvedAt: 2,
        outcome: "auto-declined-headless",
        title: "Fill in the form",
        questions: [
          {
            prompt: "Question 1",
            options: ["Option A", "Option B", "Option C", "Option D", "Option E",
              "Option F", "Option G", "Option H", "Option I", "Option J"],
          },
          { prompt: "Question 2", options: [] },
          { prompt: "Question 3", options: [] },
          { prompt: "Question 4", options: [] },
          { prompt: "Question 5", options: [] },
          { prompt: "Question 6", options: [] },
        ],
      }],
    );

    expect(history!.content).toContain("Question 4");
    expect(history!.content).not.toContain("Question 5");
    expect(history!.content).not.toContain("Question 6");
    expect(history!.content).toContain(
      "Offered options: Option A, Option B, Option C, Option D, Option E, Option F, Option G, Option H",
    );
    expect(history!.content).not.toContain("Option I");
    expect(history!.content).not.toContain("Option J");
  });

  test("uses the stable fallback for an interaction timestamp outside the time clip", () => {
    const [history] = toPipelineTranscript(
      [],
      "codex",
      FALLBACK,
      [{
        id: "invalid-time",
        provider: "codex",
        kind: "question",
        phase: "build",
        requestedAt: 1,
        resolvedAt: Number.MAX_SAFE_INTEGER,
        outcome: "auto-declined-headless",
        title: "Choose safely",
        questions: [],
      }],
    );

    expect(history).toMatchObject({
      id: "pipeline-interaction:invalid-time",
      createdAt: FALLBACK,
    });
  });
});
