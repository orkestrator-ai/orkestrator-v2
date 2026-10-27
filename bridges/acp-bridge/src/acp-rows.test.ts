/**
 * One transcript row per model response (`acp-rows.ts`), driven in process
 * through the same `applySessionUpdate` path a live turn and a replay use.
 * No state directory is configured, so persistence is a no-op here.
 */
import { describe, expect, test } from "bun:test";
// Must precede every bridge import below: `acp-context.js` resolves
// `ACP_PROVIDER` at module scope and throws without it.
import "./testing/unit-test-env.js";
import { RuntimeHealthRecorder } from "@orkestrator/protocol/runtime-health";
import { bridgeTranscriptRouteBody } from "@orkestrator/protocol/node/bridge-transcript-routes";
import {
  MAX_CHILD_PARTS_PER_CALL,
  MAX_MESSAGES,
  MAX_PARTS_PER_MESSAGE,
  SOFT_PARTS_PER_ROW,
  type BridgeMessage,
  type BridgeToolPart,
  type SessionState,
} from "./acp-context.js";
import { applySessionUpdate } from "./acp-session.js";
import { applyCursorTask, applyCursorUpdateTodos, syncActiveSubagentTool } from "./acp-tools.js";
import { emptySessionConfig } from "./acp-persistence.js";
import { messageWindow } from "./acp-public.js";
import { acpTranscriptSource } from "./acp-transcript-source.js";

let nextId = 0;

function runningState(options: { structured?: boolean } = {}): SessionState {
  nextId += 1;
  const id = `rows-${nextId}`;
  return {
    id,
    acpSessionId: `vendor-${id}`,
    status: "running",
    messages: [
      {
        id: `${id}-user`,
        role: "user",
        content: "go",
        parts: [],
        createdAt: new Date().toISOString(),
      },
    ],
    activeSubagentToolIds: new Set(),
    activeSubagentDescriptors: new Map(),
    settledCursorAgentIds: new Set(),
    subagentLimitExceeded: false,
    subagentToolIds: new Map(),
    cursorTodos: [],
    historyMessageIds: new Map(),
    child: null,
    revision: 0,
    structured: new Map(),
    promptJournal: new Map(),
    grokInterjectionJournal: new Map(),
    approvals: new Map(),
    interactions: new Map(),
    outputTruncated: false,
    uncheckedTranscriptBytes: 0,
    currentTurnOutput: options.structured ? "" : null,
    promptSequence: 1,
    droppedMessages: 0,
    droppedParts: 0,
    transcriptTruncated: false,
    sessionConfig: emptySessionConfig(),
    dispatching: false,
    historyReplay: false,
    health: new RuntimeHealthRecorder(),
  };
}

function send(state: SessionState, update: Record<string, unknown>): void {
  applySessionUpdate(state, { sessionId: state.acpSessionId, update });
}

const text = (value: string) => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text: value },
});
const thought = (value: string) => ({
  sessionUpdate: "agent_thought_chunk",
  content: { type: "text", text: value },
});
const call = (toolCallId: string, extra: Record<string, unknown> = {}) => ({
  sessionUpdate: "tool_call",
  toolCallId,
  title: `Run ${toolCallId}`,
  kind: "execute",
  status: "in_progress",
  ...extra,
});
const callUpdate = (toolCallId: string, extra: Record<string, unknown> = {}) => ({
  sessionUpdate: "tool_call_update",
  toolCallId,
  ...extra,
});

/** Each row as `[role, "type:content" | "tool:id"]`, for whole-shape assertions. */
function rows(state: SessionState): Array<[string, string[]]> {
  return state.messages.map((message) => [
    message.role,
    message.parts.map((part) =>
      part.type === "tool-invocation" ? `tool:${part.toolUseId}` : `${part.type}:${part.content}`,
    ),
  ]);
}

function startTurn(state: SessionState, id: string): void {
  state.messages.push({
    id,
    role: "user",
    content: "again",
    parts: [],
    createdAt: new Date().toISOString(),
  });
}

const childOf = (parent: string) => ({ _meta: { claudeCode: { parentToolUseId: parent } } });

function toolParts(state: SessionState, toolUseId: string): BridgeToolPart[] {
  return state.messages.flatMap((message) =>
    message.parts.filter(
      (part): part is BridgeToolPart =>
        part.type === "tool-invocation" && part.toolUseId === toolUseId,
    ),
  );
}

describe("ACP transcript rows", () => {
  test("starts a new row when prose follows a tool call without a provider message id", () => {
    const state = runningState();
    send(state, thought("Planning. "));
    send(state, text("Looking first."));
    send(state, call("read-1"));
    send(state, call("read-2"));
    send(state, thought("Both read. "));
    send(state, text("Now the answer."));

    expect(rows(state)).toEqual([
      ["user", []],
      // A thought then text is one response; its calls stay with it.
      ["assistant", ["thinking:Planning. ", "text:Looking first.", "tool:read-1", "tool:read-2"]],
      // What follows a call is the model's next response.
      ["assistant", ["thinking:Both read. ", "text:Now the answer."]],
    ]);
    expect(state.messages[1]?.content).toBe("Looking first.");
    expect(state.messages[2]?.content).toBe("Now the answer.");
  });

  test("keeps per-message-id rows when the provider sends them", () => {
    const state = runningState();
    send(state, { ...text("First."), messageId: "m-1" });
    send(state, call("read-1"));
    // Same provider message after its call: the provider says it is one message.
    send(state, { ...text(" Still first."), messageId: "m-1" });
    send(state, { ...text("Second."), messageId: "m-2" });

    expect(rows(state)).toEqual([
      ["user", []],
      ["assistant", ["text:First.", "tool:read-1", "text: Still first."]],
      ["assistant", ["text:Second."]],
    ]);
  });

  test("updates a late tool call on the row holding it instead of adding a duplicate", () => {
    const state = runningState();
    send(state, call("build-1"));
    send(state, text("Waiting on the build."));
    send(state, call("lint-1"));
    send(state, text("Lint is running too."));
    const revision = state.revision;

    send(state, callUpdate("build-1", { status: "completed", rawOutput: "build ok" }));

    expect(toolParts(state, "build-1")).toHaveLength(1);
    expect(state.messages[1]?.parts[0]).toMatchObject({
      toolUseId: "build-1",
      toolState: "success",
      toolOutput: "build ok",
      toolTitle: "Run build-1",
    });
    expect(rows(state).at(-1)).toEqual(["assistant", ["text:Lint is running too."]]);
    expect(state.revision).toBeGreaterThan(revision);
  });

  test("lands a nested call on the row holding the call that launched it", () => {
    const state = runningState();
    send(state, call("task-1", { kind: "other", title: "Delegate" }));
    send(state, text("Carrying on meanwhile."));
    send(
      state,
      call("child-1", { _meta: { claudeCode: { parentToolUseId: "task-1" } }, kind: "read" }),
    );
    send(state, call("own-1"));

    expect(rows(state)).toEqual([
      ["user", []],
      ["assistant", ["tool:task-1", "tool:child-1"]],
      ["assistant", ["text:Carrying on meanwhile.", "tool:own-1"]],
    ]);
    expect(toolParts(state, "child-1")[0]).toMatchObject({ parentTaskUseId: "task-1" });
  });

  test("starts a new call that reuses an id from an earlier turn on the current row", () => {
    const state = runningState();
    send(state, call("call-1", { status: "completed" }));
    state.messages.push({
      id: "second-user",
      role: "user",
      content: "again",
      parts: [],
      createdAt: new Date().toISOString(),
    });
    send(state, call("call-1"));

    expect(rows(state)).toEqual([
      ["user", []],
      ["assistant", ["tool:call-1"]],
      ["user", []],
      ["assistant", ["tool:call-1"]],
    ]);
    expect(toolParts(state, "call-1").map((part) => part.toolState)).toEqual([
      "success",
      "pending",
    ]);
  });

  test("keeps one checklist per turn when a plan update follows a later response", () => {
    const state = runningState();
    const entries = (status: string) => [{ content: "Ship it", status, priority: "high" }];
    send(state, { sessionUpdate: "plan", entries: entries("pending") });
    send(state, text("Starting."));
    send(state, call("work-1"));
    send(state, text("Done with the work."));
    send(state, { sessionUpdate: "plan", entries: entries("completed") });

    expect(toolParts(state, "acp-plan")).toHaveLength(1);
    expect(state.messages[1]?.parts[0]).toMatchObject({ toolUseId: "acp-plan" });
    expect(rows(state).at(-1)).toEqual(["assistant", ["text:Done with the work."]]);
  });

  test("re-sends an older row that changed in an incremental read", () => {
    const state = runningState();
    send(state, call("build-1"));
    send(state, text("Waiting."));
    // The reader holds every row and polls from its last index.
    const lastIndex = state.droppedMessages + state.messages.length - 1;
    const before = messageWindow(state, lastIndex) as { baseIndex: number };
    expect(before.baseIndex).toBe(lastIndex);

    send(state, callUpdate("build-1", { status: "completed", rawOutput: "done" }));

    const after = messageWindow(state, lastIndex) as {
      baseIndex: number;
      messages: BridgeMessage[];
    };
    expect(after.baseIndex).toBe(1);
    expect(after.messages.map((message) => message.id)).toEqual([
      state.messages[1]!.id,
      state.messages[2]!.id,
    ]);
    expect(after.messages[0]?.parts[0]).toMatchObject({ toolState: "success" });
    // A read of the whole window is unaffected.
    expect((messageWindow(state, null) as { baseIndex: number }).baseIndex).toBe(0);
  });

  test("serves exactly the newest rows for a tail read, ignoring the mutated-row floor", () => {
    const state = runningState();
    send(state, call("build-1"));
    send(state, text("Waiting."));
    send(state, callUpdate("build-1", { status: "completed", rawOutput: "done" }));
    const total = state.droppedMessages + state.messages.length;

    const tail = messageWindow(state, null, 1) as {
      baseIndex: number;
      messages: BridgeMessage[];
      messageWindow: { truncated: boolean; omittedMessages?: number };
    };
    expect(tail.messages.map((message) => message.id)).toEqual([state.messages.at(-1)!.id]);
    expect(tail.baseIndex).toBe(total - 1);
    expect(tail.messageWindow).toMatchObject({ truncated: true, omittedMessages: total - 1 });
    // A limit larger than the history is the whole window.
    expect((messageWindow(state, null, 99) as { baseIndex: number }).baseIndex).toBe(0);
    // An anchor wins over a limit, keeping the incremental floor.
    expect((messageWindow(state, total - 1, 1) as { baseIndex: number }).baseIndex).toBe(1);
  });

  test("changes the progressive transcript token when an older row changes", () => {
    const state = runningState();
    send(state, call("build-1"));
    send(state, text("Waiting."));
    const read = (knownToken?: string) =>
      bridgeTranscriptRouteBody(acpTranscriptSource(state, "test"), (name) =>
        name === "knownToken" ? (knownToken ?? null) : null,
      );
    const first = read();
    expect(read(first.token).status).toBe("unchanged");

    send(state, callUpdate("build-1", { status: "completed" }));

    const second = read(first.token);
    expect(second.status).toBe("snapshot");
    const messages = "value" in second ? (second.value.messages as BridgeMessage[]) : [];
    expect(messages[1]?.parts[0]).toMatchObject({ toolUseId: "build-1", toolState: "success" });
  });

  test("holds a subagent's calls to a bound on its row and never trims the launch card", () => {
    const state = runningState({ structured: true });
    send(state, call("task", { kind: "other", title: "Delegate" }));
    const children = 600;
    for (let index = 0; index < children; index += 1) {
      send(state, call(`child-${index}`, { ...childOf("task"), status: "completed" }));
    }

    // The launch card stays first on its row, with only the newest children.
    const row = state.messages[1]!;
    expect(row.parts[0]).toMatchObject({ toolUseId: "task" });
    expect(row.parts).toHaveLength(1 + MAX_CHILD_PARTS_PER_CALL);
    expect(row.parts.at(1)).toMatchObject({
      toolUseId: `child-${children - MAX_CHILD_PARTS_PER_CALL}`,
    });
    expect(row.parts.at(-1)).toMatchObject({ toolUseId: `child-${children - 1}` });
    expect(state.messages).toHaveLength(2);
    // Shedding is display only: a long subagent does not fail the turn.
    expect(state.status).toBe("running");
    expect(state.error).toBeUndefined();

    // The launch still completes on its card.
    send(state, callUpdate("task", { status: "completed", rawOutput: "all done" }));
    expect(toolParts(state, "task")).toEqual([
      expect.objectContaining({ toolState: "success", toolOutput: "all done" }),
    ]);
    // A late update for a shed child is dropped, not rebuilt as an empty card.
    send(state, callUpdate("child-0", { status: "failed" }));
    expect(toolParts(state, "child-0")).toHaveLength(0);
  });

  test("lets several subagents share a row without trimming its launch cards", () => {
    const state = runningState();
    const launches = ["task-a", "task-b", "task-c", "task-d", "task-e"];
    for (const launch of launches) send(state, call(launch, { kind: "other" }));
    for (let index = 0; index < MAX_CHILD_PARTS_PER_CALL; index += 1) {
      for (const launch of launches) {
        send(state, call(`${launch}-${index}`, { ...childOf(launch), status: "completed" }));
      }
    }

    const row = state.messages[1]!;
    expect(row.parts.length).toBeLessThanOrEqual(MAX_PARTS_PER_MESSAGE);
    expect(row.parts.slice(0, launches.length).map((part) => part.sourcePartId)).toEqual(
      launches.map((launch) => `tool:${launch}`),
    );
    expect(row.parts.some((part) => part.content.includes("were dropped"))).toBe(false);
  });

  test("opens the next row for back-to-back calls at the soft bound instead of trimming", () => {
    const state = runningState({ structured: true });
    const calls = MAX_PARTS_PER_MESSAGE + 100;
    for (let index = 0; index < calls; index += 1) {
      send(state, call(`flood-${index}`, { status: "completed" }));
    }

    expect(state.messages.slice(1).map((message) => message.parts.length)).toEqual([
      SOFT_PARTS_PER_ROW,
      SOFT_PARTS_PER_ROW,
      calls - 2 * SOFT_PARTS_PER_ROW,
    ]);
    expect(toolParts(state, "flood-0")).toHaveLength(1);
    expect(state.droppedParts).toBe(0);
    expect(state.status).toBe("running");
    expect(state.error).toBeUndefined();
  });

  test("does not rebuild a call trimmed from an earlier row on the trailing row", () => {
    const state = runningState();
    // A response the provider names holds more parts than a row may, so the
    // oldest are trimmed, its call among them.
    send(state, { ...text("Start."), messageId: "big" });
    send(state, call("early-1"));
    for (let index = 0; index < MAX_PARTS_PER_MESSAGE; index += 1) {
      send(state, { ...(index % 2 === 0 ? thought("t") : text("x")), messageId: "big" });
    }
    expect(toolParts(state, "early-1")).toHaveLength(0);
    send(state, { ...text("Next response."), messageId: "next" });
    const trailing = state.messages.at(-1)!;

    send(state, callUpdate("early-1", { status: "failed" }));

    expect(toolParts(state, "early-1")).toHaveLength(0);
    expect(state.messages.at(-1)).toBe(trailing);
    expect(rows(state).at(-1)).toEqual(["assistant", ["text:Next response."]]);
  });

  test("starts a new card for an update reusing a settled id from an earlier turn", () => {
    const state = runningState();
    send(state, call("tool_0", { status: "completed", rawOutput: "turn one" }));
    startTurn(state, "turn-two");

    send(state, callUpdate("tool_0", { title: "turn two", status: "in_progress" }));

    expect(toolParts(state, "tool_0")).toEqual([
      expect.objectContaining({ toolState: "success", toolTitle: "Run tool_0" }),
      expect.objectContaining({ toolState: "pending", toolTitle: "turn two" }),
    ]);
    expect(rows(state).at(-1)).toEqual(["assistant", ["tool:tool_0"]]);
  });

  test("still completes an earlier turn's unsettled call from a late update", () => {
    const state = runningState();
    send(state, call("long-1"));
    startTurn(state, "turn-two");
    send(state, text("Meanwhile."));

    send(state, callUpdate("long-1", { status: "completed", rawOutput: "finally" }));

    expect(toolParts(state, "long-1")).toEqual([
      expect.objectContaining({ toolState: "success", toolOutput: "finally" }),
    ]);
    expect(state.messages[1]?.parts[0]).toMatchObject({ toolUseId: "long-1" });
  });

  test("keeps one card for a resent child of a background subagent from an earlier turn", () => {
    const state = runningState();
    send(
      state,
      call("bg", {
        kind: "other",
        title: "Background task",
        rawInput: { _toolName: "task", run_in_background: true },
        status: "completed",
      }),
    );
    expect(state.activeSubagentToolIds.has("bg")).toBe(true);
    send(state, call("bg-child", childOf("bg")));
    startTurn(state, "turn-two");

    // The vendor resends the child's initial call while the parent runs on.
    send(state, call("bg-child", { ...childOf("bg"), status: "completed" }));

    expect(toolParts(state, "bg-child")).toEqual([
      expect.objectContaining({ toolState: "success", parentTaskUseId: "bg" }),
    ]);
    expect(rows(state)[1]).toEqual(["assistant", ["tool:bg", "tool:bg-child"]]);
  });

  test("a reused active subagent id retains its launch and settles on its late result", () => {
    const state = runningState();
    send(
      state,
      call("bg", {
        kind: "other",
        title: "Background task",
        rawInput: { _toolName: "task", run_in_background: true },
        status: "completed",
      }),
    );
    expect(state.activeSubagentToolIds.has("bg")).toBe(true);
    startTurn(state, "turn-two");

    send(state, call("bg", { kind: "read", title: "Read notes.md", status: "pending" }));

    const cards = toolParts(state, "bg");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ content: "Background task", agentState: "active" });
    expect(state.activeSubagentToolIds.has("bg")).toBe(true);
    applyCursorTask(state, { toolCallId: "bg", status: "completed" });
    expect(cards[0]).toMatchObject({ agentState: "finished" });
    expect(state.activeSubagentToolIds.has("bg")).toBe(false);
  });

  test("does not rebuild a Cursor todo or task card for a call a trim removed", () => {
    const state = runningState();
    send(state, call("gone-todos"));
    send(state, call("gone-task", { kind: "other" }));
    state.messages[1]!.parts = [];
    state.evictedToolCallIds = new Set(["gone-todos", "gone-task"]);
    send(state, text("Later."));
    const trailing = state.messages.at(-1)!;

    applyCursorUpdateTodos(state, {
      toolCallId: "gone-todos",
      todos: [{ id: "1", content: "Ship it", status: "in_progress" }],
      merge: false,
    });
    applyCursorTask(state, { toolCallId: "gone-task", description: "Late metadata" });

    expect(toolParts(state, "gone-todos")).toHaveLength(0);
    expect(toolParts(state, "gone-task")).toHaveLength(0);
    expect(trailing.parts.map((part) => part.type)).toEqual(["text"]);
    // The list itself is still the session's.
    expect(state.cursorTodos).toEqual([
      expect.objectContaining({ id: "1", content: "Ship it", status: "in_progress" }),
    ]);
  });

  test("carries a late change to a row outside the live window in the next v2 snapshot", () => {
    const state = runningState();
    send(state, call("build-1"));
    for (let index = 0; index < 6; index += 1) {
      send(state, text(`Step ${index}.`));
      send(state, call(`step-${index}`, { status: "completed" }));
    }
    const read = (knownToken?: string) =>
      bridgeTranscriptRouteBody(acpTranscriptSource(state, "test"), (name) => {
        if (name === "version") return "2";
        if (name === "limit") return "3";
        return name === "knownToken" ? (knownToken ?? null) : null;
      });
    const before = read();
    const beforeValue = "value" in before ? before.value : undefined;
    expect(beforeValue?.startIndex).toBeGreaterThan(1);
    expect(beforeValue?.revisedMessages).toBeUndefined();

    send(state, callUpdate("build-1", { status: "completed", rawOutput: "built" }));

    const after = read(before.token);
    expect(after.status).toBe("snapshot");
    const revised = ("value" in after ? after.value.revisedMessages : undefined) as
      BridgeMessage[] | undefined;
    expect(revised?.map((message) => message.id)).toEqual([state.messages[1]!.id]);
    expect(revised?.[0]?.parts[0]).toMatchObject({ toolUseId: "build-1", toolState: "success" });
  });

  test("does not fail a long structured turn that spans many responses", () => {
    const state = runningState({ structured: true });
    // More calls than one row may hold, over more responses than the
    // transcript retains: the turn is long, but no single response is.
    const responses = MAX_MESSAGES + 50;
    for (let index = 0; index < responses; index += 1) {
      send(state, text(`Step ${index}.`));
      send(state, call(`step-${index}`, { status: "completed" }));
    }
    send(state, text('{"done":true}'));

    expect(state.status).toBe("running");
    expect(state.error).toBeUndefined();
    expect(state.outputTruncated).toBe(false);
    expect(responses).toBeGreaterThan(MAX_PARTS_PER_MESSAGE);
    expect(state.messages.length).toBeLessThanOrEqual(MAX_MESSAGES);
    expect(state.droppedMessages).toBeGreaterThan(0);
    expect(state.messages.every((message) => message.parts.length <= 2)).toBe(true);
    expect(state.currentTurnOutput?.endsWith('{"done":true}')).toBe(true);

    // A late update for a call whose row was evicted is dropped, not rebuilt
    // as an empty part on the trailing row.
    const trailing = state.messages.at(-1)!;
    send(state, callUpdate("step-0", { status: "failed" }));
    expect(toolParts(state, "step-0")).toHaveLength(0);
    expect(state.messages.at(-1)).toBe(trailing);
  });
});

test("newest-row streaming never fills revised notes", () => {
  const state = runningState();
  send(state, text("start"));
  for (let i = 0; i < 40; i++) send(state, text(" delta"));
  expect(state.revisedRows?.ids() ?? []).toEqual([]);
});

test("a long whitespace-padded launch title compares its source rather than its rewritten card", () => {
  const state = runningState();
  const title = `  ${"background task ".repeat(100)}  `;
  send(
    state,
    call("bg-long", {
      title,
      kind: "other",
      rawInput: { _toolName: "task", run_in_background: true },
      status: "completed",
    }),
  );
  const launch = toolParts(state, "bg-long")[0]!;
  launch.content = "rendered launch description";
  startTurn(state, "next");
  send(state, call("bg-long", { title, kind: "other", status: "completed" }));
  expect(toolParts(state, "bg-long")).toEqual([launch]);
  expect(state.activeSubagentToolIds.has("bg-long")).toBe(true);
});

test("synchronizing a duplicate card cannot settle the registered active launch", () => {
  const state = runningState();
  send(
    state,
    call("launch", {
      kind: "other",
      title: "Background task",
      status: "completed",
      rawInput: { _toolName: "task", run_in_background: true },
    }),
  );
  const launch = toolParts(state, "launch")[0]!;
  syncActiveSubagentTool(state, { ...launch, agentState: undefined, toolState: "success" });
  expect(state.activeSubagentToolIds.has("launch")).toBe(true);
  expect(launch.agentState).toBe("active");
});

test("late active subagent updates bypass a conflicting duplicate and finish their launch", () => {
  const state = runningState();
  send(
    state,
    call("launch", {
      kind: "other",
      title: "Background task",
      status: "completed",
      rawInput: { _toolName: "task", run_in_background: true },
    }),
  );
  const launch = toolParts(state, "launch")[0]!;
  startTurn(state, "next");
  send(state, text("later"));
  const duplicate = { ...launch, toolName: "read", agentState: undefined, content: "duplicate" };
  state.messages.at(-1)!.parts.push(duplicate);
  send(state, callUpdate("launch", { rawOutput: "progress" }));
  expect(launch.toolOutput).toBe("progress");
  expect(duplicate.toolOutput).not.toBe("progress");
  expect(state.activeSubagentToolIds.has("launch")).toBe(true);
  applyCursorTask(state, { toolCallId: "launch", status: "completed" });
  expect(launch.agentState).toBe("finished");
  expect(state.activeSubagentToolIds.has("launch")).toBe(false);
});
