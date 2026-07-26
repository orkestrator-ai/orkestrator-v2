import { describe, test, expect } from "bun:test";
import {
  isIgnoredNotification,
  reduceHistoricalTurns,
  reduceNotification,
  toTurnError,
} from "./event-reducer.js";
import { adaptAppServerItem, planUpdateToTodoList, userMessageClientId } from "./item-adapter.js";
import type { InboundNotification } from "./envelope-validation.js";
import type { EngineEvent } from "../engine/types.js";

function notify(method: string, params: unknown): InboundNotification {
  return { kind: "notification", method, params };
}

function reduce(method: string, params: unknown): EngineEvent[] {
  return reduceNotification(notify(method, params), 1, "handle-1").events;
}

describe("thread and turn lifecycle", () => {
  test("thread/started binds the nested thread id", () => {
    expect(reduce("thread/started", { thread: { id: "thread-1" } })).toEqual([
      { kind: "thread.started", threadId: "thread-1", engineGeneration: 1, handle: "handle-1" },
    ]);
  });

  test("turn/started reports the real turn id", () => {
    const events = reduce("turn/started", { threadId: "t1", turn: { id: "turn-1" } });
    expect(events[0]).toMatchObject({ kind: "turn.started", threadId: "t1", turnId: "turn-1" });
  });

  test("turn/completed maps each terminal status", () => {
    for (const [status, expected] of [
      ["completed", "completed"],
      ["interrupted", "interrupted"],
      ["failed", "failed"],
    ] as const) {
      const events = reduce("turn/completed", {
        threadId: "t1",
        turn: { id: "turn-1", status, error: { message: "boom" } },
      });
      expect(events[0]).toMatchObject({ kind: "turn.completed", status: expected });
    }
  });

  test("only a failed turn carries the error", () => {
    const completed = reduce("turn/completed", {
      threadId: "t1",
      turn: { id: "turn-1", status: "completed", error: { message: "stale" } },
    });
    expect((completed[0] as { error?: unknown }).error).toBeUndefined();

    const failed = reduce("turn/completed", {
      threadId: "t1",
      turn: { id: "turn-1", status: "failed", error: { message: "real failure" } },
    });
    expect((failed[0] as { error?: { message: string } }).error?.message).toBe("real failure");
  });

  test("a standalone error is not terminal", () => {
    const events = reduce("error", {
      threadId: "t1",
      turnId: "turn-1",
      error: { message: "upstream hiccup" },
      willRetry: true,
    });

    // app-server can report a retryable error and still complete the turn, so
    // this must not be treated as the end of it.
    expect(events[0]!.kind).toBe("error");
    expect(events[0]).toMatchObject({ willRetry: true });
  });

  test("malformed lifecycle payloads are dropped, not thrown", () => {
    expect(reduce("thread/started", {})).toEqual([]);
    expect(reduce("turn/started", { threadId: "t1" })).toEqual([]);
    expect(reduce("turn/completed", { threadId: "t1", turn: {} })).toEqual([]);
    expect(reduce("item/started", { threadId: "t1" })).toEqual([]);
  });
});

describe("usage and limits", () => {
  test("preserves exact Codex token breakdown and context window", () => {
    const events = reduce("thread/tokenUsage/updated", {
      threadId: "t1",
      turnId: "turn-1",
      tokenUsage: {
        total: {
          totalTokens: 15_000,
          inputTokens: 10_000,
          cachedInputTokens: 2_000,
          cacheWriteInputTokens: 500,
          outputTokens: 3_000,
          reasoningOutputTokens: 1_000,
        },
        last: {
          totalTokens: 25_000,
          inputTokens: 20_000,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 5_000,
          reasoningOutputTokens: 2_000,
        },
        modelContextWindow: 100_000,
      },
    });

    expect(events[0]).toMatchObject({
      kind: "thread.usage.updated",
      threadId: "t1",
      usage: {
        usedTokens: 25_000,
        totalTokens: 100_000,
        percentUsed: 25,
        inputTokens: 10_000,
        outputTokens: 3_000,
        cacheReadTokens: 2_000,
        reasoningTokens: 1_000,
        sessionTokens: 15_000,
        estimated: false,
      },
    });
  });

  test("normalizes account rate-limit windows and credits", () => {
    const events = reduce("account/rateLimits/updated", {
      rateLimits: {
        limitName: "Five hour",
        primary: { usedPercent: 60, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 20, resetsAt: null },
        credits: { balance: "12.50", hasCredits: true, unlimited: false },
      },
    });

    expect(events[0]).toMatchObject({
      kind: "account.rateLimits.updated",
      credits: { balance: "12.50", hasCredits: true, unlimited: false },
      rateLimits: [
        { label: "Five hour", usedPercent: 60 },
        { label: "Secondary", usedPercent: 20 },
      ],
    });
  });
});

describe("deltas", () => {
  test("agent message delta", () => {
    const events = reduce("item/agentMessage/delta", {
      threadId: "t1",
      turnId: "turn-1",
      itemId: "i1",
      delta: "hello",
    });
    expect(events[0]).toMatchObject({ kind: "item.text.delta", itemId: "i1", delta: "hello" });
  });

  test("reasoning summary and content deltas carry their channel and index", () => {
    const summary = reduce("item/reasoning/summaryTextDelta", {
      threadId: "t1",
      turnId: "turn-1",
      itemId: "r1",
      delta: "s",
      summaryIndex: 2,
    });
    expect(summary[0]).toMatchObject({ channel: "summary", index: 2 });

    const content = reduce("item/reasoning/textDelta", {
      threadId: "t1",
      turnId: "turn-1",
      itemId: "r1",
      delta: "c",
      contentIndex: 3,
    });
    expect(content[0]).toMatchObject({ channel: "content", index: 3 });
  });

  test("an empty delta is preserved, but a missing one is dropped", () => {
    expect(
      reduce("item/agentMessage/delta", {
        threadId: "t1",
        turnId: "turn-1",
        itemId: "i1",
        delta: "",
      }),
    ).toHaveLength(1);
    expect(
      reduce("item/agentMessage/delta", { threadId: "t1", turnId: "turn-1", itemId: "i1" }),
    ).toHaveLength(0);
  });

  test("command output delta", () => {
    const events = reduce("item/commandExecution/outputDelta", {
      threadId: "t1",
      turnId: "turn-1",
      itemId: "c1",
      delta: "line\n",
    });
    expect(events[0]).toMatchObject({ kind: "item.command.outputDelta", delta: "line\n" });
  });

  test("turn diff", () => {
    const events = reduce("turn/diff/updated", {
      threadId: "t1",
      turnId: "turn-1",
      diff: "diff --git a/x b/x",
    });
    expect(events[0]).toMatchObject({ kind: "turn.diff", diff: "diff --git a/x b/x" });
  });

  test("a delta without a turn id is dropped rather than misattributed", () => {
    expect(
      reduce("item/agentMessage/delta", { threadId: "t1", itemId: "i1", delta: "x" }),
    ).toEqual([]);
  });
});

describe("unknown and ignored notifications", () => {
  test("an unrecognised method is reported, never thrown", () => {
    const result = reduceNotification(notify("codex/brand/new", { threadId: "t1" }), 1);

    // Crashing here would take down every Codex tab in the environment for a
    // purely additive protocol change.
    expect(result.unknownMethod).toBe("codex/brand/new");
    expect(result.events[0]).toMatchObject({ kind: "unknown.protocol", method: "codex/brand/new" });
  });

  test("known-but-irrelevant methods are silently ignored", () => {
    for (const method of ["account/updated", "warning"]) {
      const result = reduceNotification(notify(method, {}), 1);
      expect(result.events).toEqual([]);
      expect(result.unknownMethod).toBeUndefined();
      expect(isIgnoredNotification(method)).toBe(true);
    }
  });

  test("the ignore list does not swallow methods the reducer handles", () => {
    for (const method of [
      "turn/started",
      "turn/completed",
      "item/started",
      "item/completed",
      "item/agentMessage/delta",
      "turn/diff/updated",
      "error",
    ]) {
      expect(isIgnoredNotification(method)).toBe(false);
    }
  });
});

describe("item adaptation", () => {
  test("agentMessage becomes the SDK agent_message shape", () => {
    expect(adaptAppServerItem({ id: "i1", type: "agentMessage", text: "hi" }).item).toEqual({
      id: "i1",
      type: "agent_message",
      text: "hi",
    });
  });

  test("reasoning prefers summary and falls back to content", () => {
    expect(
      adaptAppServerItem({ id: "r1", type: "reasoning", summary: ["a", "b"], content: ["raw"] })
        .item,
    ).toEqual({ id: "r1", type: "reasoning", text: "a\n\nb" });

    expect(
      adaptAppServerItem({ id: "r1", type: "reasoning", summary: [], content: ["raw"] }).item,
    ).toEqual({ id: "r1", type: "reasoning", text: "raw" });
  });

  test("commandExecution statuses map onto the SDK enum", () => {
    const cases: Array<[string, string]> = [
      ["inProgress", "in_progress"],
      ["completed", "completed"],
      ["failed", "failed"],
      // A declined command never ran and never will; "in progress" would spin.
      ["declined", "failed"],
    ];
    for (const [input, expected] of cases) {
      expect(
        adaptAppServerItem({
          id: "c1",
          type: "commandExecution",
          command: "ls",
          status: input,
          aggregatedOutput: "out",
        }).item,
      ).toMatchObject({ type: "command_execution", status: expected });
    }
  });

  test("commandExecution carries output and exit code", () => {
    expect(
      adaptAppServerItem({
        id: "c1",
        type: "commandExecution",
        command: "ls",
        status: "completed",
        aggregatedOutput: "a.txt",
        exitCode: 0,
      }).item,
    ).toEqual({
      id: "c1",
      type: "command_execution",
      command: "ls",
      aggregated_output: "a.txt",
      status: "completed",
      exit_code: 0,
    });
  });

  test("fileChange unwraps the nested change kind", () => {
    expect(
      adaptAppServerItem({
        id: "f1",
        type: "fileChange",
        status: "completed",
        changes: [
          { path: "a.ts", kind: { type: "add" } },
          { path: "b.ts", kind: { type: "update", move_path: null } },
          { path: "c.ts", kind: { type: "delete" } },
        ],
      }).item,
    ).toEqual({
      id: "f1",
      type: "file_change",
      status: "completed",
      changes: [
        { path: "a.ts", kind: "add" },
        { path: "b.ts", kind: "update" },
        { path: "c.ts", kind: "delete" },
      ],
    });
  });

  test("mcpToolCall preserves result and error", () => {
    const item = adaptAppServerItem({
      id: "m1",
      type: "mcpToolCall",
      server: "srv",
      tool: "search",
      status: "failed",
      arguments: { q: 1 },
      error: { message: "nope" },
    }).item as Record<string, unknown>;

    expect(item).toMatchObject({
      type: "mcp_tool_call",
      server: "srv",
      tool: "search",
      status: "failed",
      error: { message: "nope" },
    });
  });

  test("collabAgentToolCall converts to the existing snake_case collab shape", () => {
    // Matching the shape the rollout-based subagent reconciler already consumes
    // is what lets native and rollout sources be compared during rollout.
    const item = adaptAppServerItem({
      id: "collab-1",
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      status: "inProgress",
      senderThreadId: "parent",
      receiverThreadIds: ["child-1"],
      prompt: "do the thing",
      agentsStates: { "child-1": { status: "pendingInit", message: null } },
    }).item as Record<string, unknown>;

    expect(item).toMatchObject({
      type: "collab_tool_call",
      tool: "spawn_agent",
      status: "in_progress",
      sender_thread_id: "parent",
      receiver_thread_ids: ["child-1"],
      prompt: "do the thing",
      agents_states: { "child-1": { status: "pending_init", message: null } },
    });
  });

  test("collab agent statuses convert from camelCase", () => {
    const item = adaptAppServerItem({
      id: "c",
      type: "collabAgentToolCall",
      tool: "wait",
      agentsStates: {
        a: { status: "notFound" },
        b: { status: "completed" },
        c: { status: "pendingInit" },
      },
    }).item as { agents_states: Record<string, { status: string }> };

    expect(item.agents_states.a!.status).toBe("not_found");
    expect(item.agents_states.b!.status).toBe("completed");
    expect(item.agents_states.c!.status).toBe("pending_init");
  });

  test("subAgentActivity keeps the child thread id", () => {
    expect(
      adaptAppServerItem({
        id: "s1",
        type: "subAgentActivity",
        kind: "interacted",
        agentThreadId: "child-1",
        agentPath: "root/child",
      }).item,
    ).toEqual({
      id: "s1",
      type: "subagent_activity",
      activity: "interacted",
      agent_thread_id: "child-1",
      agent_path: "root/child",
    });
  });

  test("userMessage is recognised but never rendered as assistant output", () => {
    const result = adaptAppServerItem({ id: "u1", type: "userMessage", clientId: "req-1" });
    expect(result.item).toBeNull();
    expect(result.unsupportedType).toBe("userMessage");
    // It is still the key for dispatch reconciliation.
    expect(userMessageClientId({ type: "userMessage", clientId: "req-1" })).toBe("req-1");
  });

  test("a genuinely unknown item type is reported for metrics", () => {
    const result = adaptAppServerItem({ id: "x", type: "quantumThing" });
    expect(result.item).toBeNull();
    expect(result.unsupportedType).toBe("quantumThing");
  });

  test("malformed items are rejected without throwing", () => {
    expect(adaptAppServerItem(null).item).toBeNull();
    expect(adaptAppServerItem("nope").item).toBeNull();
    expect(adaptAppServerItem({ type: "agentMessage" }).item).toBeNull();
    expect(adaptAppServerItem({ id: "i" }).item).toBeNull();
  });
});

describe("plan synthesis", () => {
  test("turn/plan/updated becomes a todo_list under a stable per-turn id", () => {
    const events = reduce("turn/plan/updated", {
      threadId: "t1",
      turnId: "turn-1",
      plan: [
        { step: "First", status: "completed" },
        { step: "Second", status: "inProgress" },
      ],
    });

    expect(events[0]).toMatchObject({ kind: "item.updated" });
    expect((events[0] as { item: unknown }).item).toEqual({
      id: "plan-turn-1",
      type: "todo_list",
      items: [
        { text: "First", completed: true },
        { text: "Second", completed: false },
      ],
    });
  });

  test("successive plan updates replace rather than stack", () => {
    const first = planUpdateToTodoList("turn-1", [{ step: "a", status: "pending" }]);
    const second = planUpdateToTodoList("turn-1", [{ step: "a", status: "completed" }]);
    expect((first as { id: string }).id).toBe((second as { id: string }).id);
  });

  test("an empty plan produces nothing", () => {
    expect(planUpdateToTodoList("turn-1", [])).toBeNull();
    expect(planUpdateToTodoList("turn-1", "not a list")).toBeNull();
  });
});

describe("in-progress patch updates", () => {
  test("patchUpdated surfaces the diff before the patch is applied", () => {
    const events = reduce("item/fileChange/patchUpdated", {
      threadId: "t1",
      turnId: "turn-1",
      itemId: "f1",
      changes: [{ path: "a.ts", kind: { type: "update", move_path: null }, diff: "@@" }],
    });

    expect(events[0]).toMatchObject({ kind: "item.updated" });
    expect((events[0] as { item: { id: string; changes: unknown[] } }).item.id).toBe("f1");
  });
});

describe("historical turn rehydration", () => {
  test("replays persisted turns as the same events a live stream produces", () => {
    const { events } = reduceHistoricalTurns(
      [
        {
          id: "turn-1",
          status: "completed",
          items: [
            { id: "u1", type: "userMessage", clientId: "req-1" },
            { id: "a1", type: "agentMessage", text: "answer" },
          ],
        },
      ],
      2,
      "thread-1",
    );

    expect(events.map((event) => event.kind)).toEqual([
      "turn.started",
      // userMessage is skipped: it is the prompt, not assistant output.
      "item.completed",
      "turn.completed",
    ]);
    expect(events.every((event) => event.engineGeneration === 2)).toBe(true);
  });

  test("historical items are marked completed, so deltas cannot overwrite them", () => {
    const { events } = reduceHistoricalTurns(
      [{ id: "turn-1", status: "completed", items: [{ id: "a1", type: "agentMessage", text: "x" }] }],
      1,
      "thread-1",
    );
    expect(events.filter((event) => event.kind === "item.completed")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "item.started")).toHaveLength(0);
  });

  test("a turn still in progress is not finalized on resume", () => {
    const { events } = reduceHistoricalTurns(
      [{ id: "turn-1", status: "inProgress", items: [] }],
      1,
      "thread-1",
    );

    // We are resuming *into* this turn; completing it here would report a
    // running turn as finished and let the build pipeline advance.
    expect(events.map((event) => event.kind)).toEqual(["turn.started"]);
  });

  test("collects unsupported item types for metrics", () => {
    const { unsupportedItemTypes } = reduceHistoricalTurns(
      [
        {
          id: "turn-1",
          status: "completed",
          items: [{ id: "x", type: "contextCompaction" }, { id: "y", type: "somethingNew" }],
        },
      ],
      1,
      "thread-1",
    );
    expect(unsupportedItemTypes).toEqual(["contextCompaction", "somethingNew"]);
  });

  test("non-array history is handled", () => {
    expect(reduceHistoricalTurns(undefined, 1, "t").events).toEqual([]);
    expect(reduceHistoricalTurns("nope", 1, "t").events).toEqual([]);
  });
});

describe("toTurnError", () => {
  test("preserves the structured codex error code", () => {
    expect(
      toTurnError({ message: "limit hit", codexErrorInfo: "usageLimitExceeded" }),
    ).toMatchObject({ message: "limit hit", code: "usageLimitExceeded" });
  });

  test("extracts the discriminant from an object-form error info", () => {
    expect(
      toTurnError({ message: "http failed", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } } }),
    ).toMatchObject({ code: "httpConnectionFailed" });
  });

  test("carries additional details", () => {
    expect(
      toTurnError({ message: "m", additionalDetails: "stack trace" }).details,
    ).toBe("stack trace");
  });

  test("falls back for malformed input", () => {
    expect(toTurnError(null).message).toBe("Codex reported an error");
    expect(toTurnError("plain string").message).toBe("plain string");
  });
});
