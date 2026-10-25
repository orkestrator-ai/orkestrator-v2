import { afterEach, describe, expect, test } from "bun:test";
import type { NormalizedMessage, SessionState, SSEEvent } from "../types/index.js";
import { eventEmitter } from "./event-emitter.js";
import type { OrderedPartEntry } from "./session-manager-messages.js";
import {
  MAX_SUBAGENT_PARTS_PER_CALL,
  MAX_TRACKED_STREAM_ROWS,
  createPromptStreamState,
  type PromptStreamState,
} from "./session-manager-prompt-stream.js";

const MAX_BLOCK_INDEX = 100;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A bare session, as `turn-fixture.ts` builds one: no harness, no SDK. */
function bareSession(): SessionState {
  return {
    id: `session-stream-${crypto.randomUUID()}`,
    messages: [],
    status: "running",
    createdAt: new Date(),
    lastActivity: new Date(),
  } as unknown as SessionState;
}

function streamFor(
  session: SessionState,
  options: Partial<Parameters<typeof createPromptStreamState>[2]> = {},
): PromptStreamState {
  const stream = createPromptStreamState(session, session.id, {
    flushIntervalMs: 60_000,
    maxBlockIndex: MAX_BLOCK_INDEX,
    ...options,
  });
  cleanups.push(() => stream.clearFlushTimer());
  return stream;
}

/** Frames emitted for `session` while this test runs. */
function framesFor(session: SessionState): SSEEvent[] {
  const events: SSEEvent[] = [];
  const stop = eventEmitter.subscribe((event) => {
    if (event.sessionId === session.id) events.push(event);
  });
  cleanups.push(stop);
  return events;
}

function updatedIds(events: SSEEvent[]): string[] {
  return events
    .filter((event) => event.type === "message.updated")
    .map((event) => (event.data as { message: NormalizedMessage }).message.id);
}

function frameIds(events: SSEEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.type === "message.updated") {
      return [(event.data as { message: NormalizedMessage }).message.id];
    }
    if (event.type === "message.patched") return [(event.data as { messageId: string }).messageId];
    return [];
  });
}

function row(session: SessionState, id: string): NormalizedMessage {
  const message = session.messages.find((candidate) => candidate.id === id);
  if (!message) throw new Error(`no row ${id}`);
  return message;
}

function messageStart(id: string, parentToolUseId?: string) {
  return {
    type: "stream_event",
    ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
    event: { type: "message_start", message: { id, model: "claude-opus-4-1" } },
  };
}

function blockStart(index: number, type: "text" | "thinking", parentToolUseId?: string) {
  return {
    type: "stream_event",
    ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
    event: {
      type: "content_block_start",
      index,
      content_block: type === "text" ? { type, text: "" } : { type, thinking: "" },
    },
  };
}

function delta(index: number, text: string, type: "text" | "thinking" = "text") {
  return {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index,
      delta: type === "text" ? { type: "text_delta", text } : { type: "thinking_delta", thinking: text },
    },
  };
}

/** Stream one text block for a response: start, block start, the deltas. */
function streamText(
  stream: PromptStreamState,
  apiMessageId: string,
  chunks: string[],
  parentToolUseId?: string,
): void {
  stream.applyPartialAssistantMessage(messageStart(apiMessageId, parentToolUseId));
  stream.applyPartialAssistantMessage(blockStart(0, "text", parentToolUseId));
  for (const chunk of chunks) stream.applyPartialAssistantMessage(delta(0, chunk));
}

function rootRecord(apiMessageId: string, parts: OrderedPartEntry[], uuid?: string) {
  return {
    apiMessageId,
    ...(uuid ? { uuid } : {}),
    isRoot: true,
    contentBlockCount: parts.length,
    orderedParts: parts.map((part, blockOffset) => ({ ...part, blockOffset })),
  };
}

/** A root response whose only block is a call the tracker knows about. */
function rootToolCall(stream: PromptStreamState, apiMessageId: string, toolUseId: string): void {
  stream.toolTracker.addTool(toolUseId, {
    type: "tool-invocation",
    toolName: "Task",
    toolUseId,
    toolState: "pending",
  });
  stream.applyAssistantRecord(rootRecord(apiMessageId, [{ type: "tool-ref", value: toolUseId }]));
}

function text(value: string, parentTaskUseId?: string): OrderedPartEntry {
  return { type: "text", value, ...(parentTaskUseId ? { parentTaskUseId } : {}) };
}

describe("createPromptStreamState", () => {
  test("opens one row per API message id, in creation order", () => {
    const session = bareSession();
    const events = framesFor(session);
    const stream = streamFor(session);

    streamText(stream, "msg_a", ["first"]);
    // The next response's `message_start` publishes the previous one first.
    streamText(stream, "msg_b", ["second"]);
    stream.applyAssistantRecord(rootRecord("msg_a", [text("first")]));
    stream.applyAssistantRecord(rootRecord("msg_b", [text("second")]));
    stream.applyAssistantRecord(rootRecord("msg_c", [text("third")]));

    expect(session.messages.map((message) => message.id)).toEqual(["msg_a", "msg_b", "msg_c"]);
    expect(updatedIds(events)).toEqual(["msg_a", "msg_b", "msg_c"]);
    expect(stream.currentAssistantMessage).toBe(row(session, "msg_c"));
    expect(stream.assistantOutputSeen).toBe(true);
    expect(row(session, "msg_a").modelId).toBeDefined();
  });

  test("collapses deltas for one block into one part and lets the final record overwrite them", () => {
    const session = bareSession();
    const events = framesFor(session);
    const stream = streamFor(session);

    stream.applyPartialAssistantMessage(messageStart("msg_a"));
    stream.applyPartialAssistantMessage(blockStart(0, "thinking"));
    stream.applyPartialAssistantMessage(delta(0, "pon", "thinking"));
    stream.applyPartialAssistantMessage(delta(0, "der", "thinking"));
    stream.applyPartialAssistantMessage(blockStart(1, "text"));
    for (const chunk of ["He", "ll", "o"]) {
      expect(stream.applyPartialAssistantMessage(delta(1, chunk))).toBe(true);
    }
    // Coalesced: nothing is published until a flush.
    expect(session.messages).toEqual([]);
    expect(events).toEqual([]);

    stream.flushStreamedAssistantMessage();
    const message = row(session, "msg_a");
    expect(message.parts.map((part) => [part.type, part.content])).toEqual([
      ["thinking", "ponder"],
      ["text", "Hello"],
    ]);
    expect(message.content).toBe("Hello");
    expect(updatedIds(events)).toEqual(["msg_a"]);

    // The SDK finalizes one record per block, all naming the same message.
    stream.applyAssistantRecord({
      apiMessageId: "msg_a",
      uuid: "uuid-thinking",
      isRoot: true,
      contentBlockCount: 1,
      orderedParts: [{ type: "thinking", value: "pondered", blockOffset: 0 }],
    });
    stream.applyAssistantRecord({
      apiMessageId: "msg_a",
      uuid: "uuid-text",
      isRoot: true,
      contentBlockCount: 1,
      orderedParts: [{ type: "text", value: "Hello, world", blockOffset: 0 }],
    });

    expect(session.messages).toEqual([message]);
    expect(message.parts.map((part) => [part.type, part.content])).toEqual([
      ["thinking", "pondered"],
      ["text", "Hello, world"],
    ]);
    expect(message.sdkUuid).toBe("uuid-text");
    expect(events.map((event) => event.type)).toEqual([
      "message.updated",
      "message.patched",
      "message.patched",
    ]);
  });

  test("puts a subagent's output on the row holding its call, even after a newer root row", () => {
    const session = bareSession();
    const stream = streamFor(session);

    rootToolCall(stream, "msg_parent", "task-1");
    stream.applyAssistantRecord(rootRecord("msg_newer", [text("meanwhile")]));

    streamText(stream, "msg_sub", ["sub", "agent"], "task-1");
    stream.flushStreamedAssistantMessage();
    stream.applyAssistantRecord({
      apiMessageId: "msg_sub_2",
      parentToolUseId: "task-1",
      isRoot: false,
      contentBlockCount: 1,
      orderedParts: [{ type: "text", value: "reported", parentTaskUseId: "task-1" }],
    });

    expect(session.messages.map((message) => message.id)).toEqual(["msg_parent", "msg_newer"]);
    const parent = row(session, "msg_parent");
    expect(parent.parts.map((part) => [part.type, part.content ?? part.toolUseId])).toEqual([
      ["tool-invocation", "task-1"],
      ["text", "subagent"],
      ["text", "reported"],
    ]);
    expect(parent.parts[1]!.parentTaskUseId).toBe("task-1");
    expect(row(session, "msg_newer").parts.map((part) => part.content)).toEqual(["meanwhile"]);
    expect(stream.currentAssistantMessage).toBe(row(session, "msg_newer"));
    // The parent is no longer the newest row, so its change is noted.
    expect(session.revisedRows?.ids()).toContain("msg_parent");
    expect(stream.rowHoldingTool("task-1")).toBe(parent);
    expect(stream.rowHoldingTool("unknown")).toBe(row(session, "msg_newer"));
  });

  test("refreshToolRows rebuilds an older row for a late tool result", () => {
    const session = bareSession();
    const events = framesFor(session);
    const stream = streamFor(session);

    rootToolCall(stream, "msg_old", "tool-1");
    stream.applyAssistantRecord(rootRecord("msg_new", [text("later")]));
    events.length = 0;

    stream.toolTracker.updateToolResult("tool-1", { state: "success", output: "done" });
    const published = stream.refreshToolRows(["tool-1"]);

    const old = row(session, "msg_old");
    expect(old.parts[0]).toMatchObject({ toolUseId: "tool-1", toolState: "success" });
    expect([...published]).toEqual([old, row(session, "msg_new")]);
    // Only the row whose parts moved publishes a frame.
    expect(frameIds(events)).toEqual(["msg_old"]);
    expect(session.revisedRows?.ids()).toContain("msg_old");
    expect(session.revisedRows?.ids()).not.toContain("msg_new");
  });

  test("stops tracking rows past MAX_TRACKED_STREAM_ROWS", () => {
    const session = bareSession();
    const stream = streamFor(session);

    rootToolCall(stream, "msg_0", "task-0");
    for (let index = 1; index <= MAX_TRACKED_STREAM_ROWS; index += 1) {
      stream.applyAssistantRecord(rootRecord(`msg_${index}`, [text(`row ${index}`)]));
    }
    const first = row(session, "msg_0");
    const newest = row(session, `msg_${MAX_TRACKED_STREAM_ROWS}`);
    expect(session.messages).toHaveLength(MAX_TRACKED_STREAM_ROWS + 1);
    // The forgotten row stays in the transcript exactly as published.
    expect(session.messages[0]).toBe(first);

    // A late frame for a call it held lands on the current row instead.
    expect(stream.rowHoldingTool("task-0")).toBe(newest);
    stream.applyAssistantRecord({
      apiMessageId: "msg_sub",
      parentToolUseId: "task-0",
      isRoot: false,
      contentBlockCount: 1,
      orderedParts: [{ type: "text", value: "late", parentTaskUseId: "task-0" }],
    });
    expect(first.parts).toHaveLength(1);
    expect(newest.parts.map((part) => part.content)).toEqual([
      `row ${MAX_TRACKED_STREAM_ROWS}`,
      "late",
    ]);
  });

  test("keeps at most MAX_SUBAGENT_PARTS_PER_CALL subagent parts per call", () => {
    const session = bareSession();
    const stream = streamFor(session);
    rootToolCall(stream, "msg_parent", "task-1");

    const total = MAX_SUBAGENT_PARTS_PER_CALL + 3;
    for (let index = 0; index < total; index += 1) {
      stream.applyAssistantRecord({
        apiMessageId: `msg_sub_${index}`,
        parentToolUseId: "task-1",
        isRoot: false,
        contentBlockCount: 1,
        orderedParts: [{ type: "text", value: `step ${index}`, parentTaskUseId: "task-1" }],
      });
    }

    const parts = row(session, "msg_parent").parts;
    // The call's own card stays; the subagent's oldest parts go first.
    expect(parts).toHaveLength(MAX_SUBAGENT_PARTS_PER_CALL + 1);
    expect(parts[0]).toMatchObject({ type: "tool-invocation", toolUseId: "task-1" });
    expect(parts[1]!.content).toBe(`step ${total - MAX_SUBAGENT_PARTS_PER_CALL}`);
    expect(parts.at(-1)!.content).toBe(`step ${total - 1}`);
  });

  test("ignores a block index outside 0..maxBlockIndex", () => {
    const session = bareSession();
    const stream = streamFor(session);
    stream.applyPartialAssistantMessage(messageStart("msg_a"));

    for (const index of [MAX_BLOCK_INDEX + 1, -1, 1.5, "0", undefined]) {
      expect(
        stream.applyPartialAssistantMessage({
          type: "stream_event",
          event: { type: "content_block_start", index, content_block: { type: "text", text: "x" } },
        }),
      ).toBe(false);
    }
    stream.flushStreamedAssistantMessage();
    expect(session.messages).toEqual([]);

    expect(stream.applyPartialAssistantMessage(blockStart(MAX_BLOCK_INDEX, "text"))).toBe(true);
    expect(stream.applyPartialAssistantMessage(delta(MAX_BLOCK_INDEX, "edge"))).toBe(true);
    stream.flushStreamedAssistantMessage();
    expect(row(session, "msg_a").content).toBe("edge");
  });

  test("ignores stream events it does not render", () => {
    const session = bareSession();
    const stream = streamFor(session);
    stream.applyPartialAssistantMessage(messageStart("msg_a"));

    expect(
      stream.applyPartialAssistantMessage({
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "tool_use" } },
      }),
    ).toBe(false);
    expect(
      stream.applyPartialAssistantMessage({
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta" } },
      }),
    ).toBe(false);
    expect(
      stream.applyPartialAssistantMessage({
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
      }),
    ).toBe(false);
    expect(stream.applyPartialAssistantMessage({ type: "stream_event", event: { type: "message_stop" } })).toBe(false);
    stream.flushStreamedAssistantMessage();
    expect(session.messages).toEqual([]);
  });

  test("a non-delta flush publishes pending rows oldest first", () => {
    const session = bareSession();
    const events = framesFor(session);
    const stream = streamFor(session);

    rootToolCall(stream, "msg_parent", "task-1");
    stream.applyAssistantRecord(rootRecord("msg_newer", [text("meanwhile")]));
    events.length = 0;

    // The newer row turns dirty first, then the older one.
    stream.applyPartialAssistantMessage(messageStart("msg_newer"));
    stream.applyPartialAssistantMessage(blockStart(1, "text"));
    stream.applyPartialAssistantMessage(delta(1, " more"));
    streamText(stream, "msg_sub", ["sub"], "task-1");
    expect(events).toEqual([]);

    // A new root response is a non-delta frame: it flushes before opening its row.
    stream.applyAssistantRecord(rootRecord("msg_next", [text("next")]));

    expect(frameIds(events)).toEqual(["msg_parent", "msg_newer", "msg_next"]);
  });

  test("publishes coalesced deltas once per interval, and clearFlushTimer cancels the publish", async () => {
    const session = bareSession();
    const events = framesFor(session);
    const stream = streamFor(session, { flushIntervalMs: 10 });

    streamText(stream, "msg_a", ["a", "b", "c"]);
    await Bun.sleep(40);
    expect(frameIds(events)).toEqual(["msg_a"]);
    expect(row(session, "msg_a").content).toBe("abc");

    stream.applyPartialAssistantMessage(delta(0, "d"));
    stream.clearFlushTimer();
    await Bun.sleep(40);
    // Nothing was scheduled: the delta waits in its row for the next flush.
    expect(frameIds(events)).toEqual(["msg_a"]);
    expect(row(session, "msg_a").content).toBe("abc");

    stream.flushStreamedAssistantMessage();
    expect(row(session, "msg_a").content).toBe("abcd");
    expect(frameIds(events)).toEqual(["msg_a", "msg_a"]);
  });

  test("a released turn and its successor share rows on one session", () => {
    const session = bareSession();
    const first = streamFor(session);
    rootToolCall(first, "msg_shared", "task-1");
    const shared = row(session, "msg_shared");

    session.messages.push({
      id: "next-user",
      role: "user",
      content: "continue",
      parts: [],
      createdAt: new Date().toISOString(),
    });
    const next = streamFor(session, { toolTracker: first.toolTracker });
    // The response's next block crosses the handoff and names the same API
    // message: the successor adopts its row, block count included, rather
    // than opening a second one.
    next.applyAssistantRecord(rootRecord("msg_shared", [text("done")], "late-uuid"));
    expect(next.rowHoldingTool("task-1")).toBe(shared);
    // Once adopted, the row's calls route the successor's subagent frames too.
    next.applyAssistantRecord({
      apiMessageId: "msg_sub",
      parentToolUseId: "task-1",
      isRoot: false,
      contentBlockCount: 1,
      orderedParts: [{ type: "text", value: "report", parentTaskUseId: "task-1" }],
    });

    expect(session.messages.map((message) => message.id)).toEqual(["msg_shared", "next-user"]);
    expect(shared.parts.map((part) => part.content ?? part.toolUseId)).toEqual([
      "task-1",
      "done",
      "report",
    ]);
    expect(shared.sdkUuid).toBe("late-uuid");
  });

  test("a replaced transcript does not adopt rows from the old one", () => {
    const session = bareSession();
    const first = streamFor(session);
    first.applyAssistantRecord(rootRecord("msg_a", [text("before")]));
    const before = row(session, "msg_a");

    session.messages = [];
    const next = streamFor(session);
    next.applyAssistantRecord(rootRecord("msg_a", [text("after")]));

    expect(session.messages).toHaveLength(1);
    expect(row(session, "msg_a")).not.toBe(before);
    expect(row(session, "msg_a").content).toBe("after");
    expect(before.content).toBe("before");
  });

  test("beginPostSteerScope publishes what streamed before the steer", () => {
    const session = bareSession();
    const events = framesFor(session);
    const stream = streamFor(session);

    streamText(stream, "msg_a", ["before ", "steer"]);
    expect(events).toEqual([]);
    stream.beginPostSteerScope();
    expect(frameIds(events)).toEqual(["msg_a"]);

    session.messages.push({
      id: "steer",
      role: "user",
      content: "actually",
      parts: [],
      createdAt: new Date().toISOString(),
    });
    stream.applyAssistantRecord(rootRecord("msg_b", [text("after steer")]));

    expect(session.messages.map((message) => message.id)).toEqual(["msg_a", "steer", "msg_b"]);
    expect(row(session, "msg_a").content).toBe("before steer");
  });

  test("a response that started before a steer stays above the steer's row", () => {
    const session = bareSession();
    session.messages.push({
      id: "prompt",
      role: "user",
      content: "go",
      parts: [],
      createdAt: new Date().toISOString(),
    });
    const stream = streamFor(session);

    // The response opens before the steer, but has no content yet.
    stream.applyPartialAssistantMessage(messageStart("msg_a"));
    stream.beginPostSteerScope();
    session.messages.push({
      id: "steer",
      role: "user",
      content: "actually",
      parts: [],
      createdAt: new Date().toISOString(),
    });
    stream.applyPartialAssistantMessage(blockStart(0, "text"));
    stream.applyPartialAssistantMessage(delta(0, "interrupted"));
    stream.flushStreamedAssistantMessage();
    stream.applyAssistantRecord(rootRecord("msg_b", [text("answer")]));

    expect(session.messages.map((message) => message.id)).toEqual([
      "prompt",
      "msg_a",
      "steer",
      "msg_b",
    ]);
  });
});
