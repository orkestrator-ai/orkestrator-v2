/**
 * The display budget holds while nobody is reading the transcript.
 *
 * Every test here drives the real translator and never calls a read route or
 * `boundTranscriptForRead`: an inactive tab issues no transcript reads, and
 * `/activity` deliberately does not hydrate, so the producer path is the only
 * thing standing between a long turn and unbounded memory.
 */
import { describe, expect, test } from "bun:test";
import { newSessionState } from "./agent-session.js";
import {
  MAX_CHILD_BYTES_PER_TASK,
  MAX_CHILD_PARTS_PER_TASK,
  MAX_MESSAGE_TEXT_BYTES,
  MAX_PARTS_PER_MESSAGE,
  MAX_TODO_ITEMS,
  MAX_TOOL_ARGUMENT_BYTES,
  MAX_TRANSCRIPT_BYTES,
} from "./config.js";
import {
  sessionIsWorking,
  type BridgeMessagePart,
  type BridgeToolPart,
  type SessionState,
} from "./state.js";
import {
  CHILD_TRIM_NOTICE,
  STREAM_BOUND_INTERVAL_BYTES,
  transcriptBoundSummary,
} from "./transcript.js";
import { applyInteractionUpdate, settleBackgroundChildren } from "./translate.js";

function running(): SessionState {
  const state = newSessionState();
  state.status = "running";
  return state;
}

const encodedBytes = (state: SessionState) => Buffer.byteLength(JSON.stringify(state.messages));

/** The documented transient bound: budget, one check interval, one admitted update. */
function transientCeiling(largestUpdateBytes: number): number {
  return MAX_TRANSCRIPT_BYTES + STREAM_BOUND_INTERVAL_BYTES + largestUpdateBytes;
}

function sourcePartIds(state: SessionState): string[] {
  return state.messages.flatMap((message) => message.parts.map((part) => part.sourcePartId));
}

describe("producer-side transcript bounds", () => {
  test("600 reasoning blocks with no reader stay within the part cap throughout", () => {
    // The validation probe: this used to retain all 600 parts.
    const state = running();
    for (let index = 0; index < 600; index += 1) {
      applyInteractionUpdate(state, { type: "thinking-delta", text: "x".repeat(1024) });
      applyInteractionUpdate(state, { type: "thinking-completed" });
      expect(state.messages.at(-1)!.parts.length).toBeLessThanOrEqual(MAX_PARTS_PER_MESSAGE);
    }
    expect(state.transcriptTruncated).toBe(true);
    expect(state.droppedParts).toBe(600 - MAX_PARTS_PER_MESSAGE);
    // Ids stay unique after the front of the message was shed.
    const ids = sourcePartIds(state);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("byte growth from many individually legal updates stays within the documented bound", () => {
    const state = running();
    const chunk = "é".repeat(256 * 1024); // 512 KiB of UTF-8 in 256 Ki UTF-16 units.
    const largestUpdate = Buffer.byteLength(chunk) * 2 + 4096;
    for (let index = 0; index < 80; index += 1) {
      applyInteractionUpdate(state, { type: "text-delta", text: chunk });
      applyInteractionUpdate(state, {
        type: "tool-call-started",
        callId: `read-${index}`,
        toolCall: { type: "read", args: { path: `f${index}.ts` } },
      });
      expect(encodedBytes(state)).toBeLessThanOrEqual(transientCeiling(largestUpdate));
    }
    expect(state.transcriptTruncated).toBe(true);
  });

  test("text charges are UTF-8 and escape aware rather than UTF-16 length", () => {
    const state = running();
    applyInteractionUpdate(state, { type: "text-delta", text: "a" });
    const before = state.uncheckedTranscriptBytes;
    applyInteractionUpdate(state, { type: "text-delta", text: '中"\n' });
    // Part and message body both grow, each by 3 + 2 + 2 encoded bytes.
    expect(state.uncheckedTranscriptBytes - before).toBe(14);
  });

  test("an unobserved stream's charged bytes never lag the real growth", () => {
    const state = running();
    let measured = encodedBytes(state);
    for (let index = 0; index < 200; index += 1) {
      const unchecked = state.uncheckedTranscriptBytes;
      applyInteractionUpdate(state, {
        type: index % 3 === 0 ? "thinking-delta" : "text-delta",
        text: `line ${index} "quoted" \\ ${"😀".repeat(index % 7)}\n`,
      });
      if (index % 5 === 0) applyInteractionUpdate(state, { type: "thinking-completed" });
      const now = encodedBytes(state);
      if (state.uncheckedTranscriptBytes >= unchecked) {
        expect(state.uncheckedTranscriptBytes - unchecked).toBeGreaterThanOrEqual(now - measured);
      }
      measured = now;
    }
  });

  test("interleaved text, tools, summaries and nested updates keep lookups working after trims", () => {
    const state = running();
    for (let round = 0; round < 700; round += 1) {
      applyInteractionUpdate(state, { type: "thinking-delta", text: `why ${round}` });
      applyInteractionUpdate(state, { type: "thinking-completed" });
      applyInteractionUpdate(state, { type: "text-delta", text: `says ${round}` });
      if (round % 4 === 0) {
        applyInteractionUpdate(state, {
          type: "tool-call-started",
          callId: `call-${round}`,
          toolCall: { type: "read", args: { path: "a.ts" } },
        });
      }
      if (round % 9 === 0) applyInteractionUpdate(state, { type: "summary", summary: `s${round}` });
      if (round % 6 === 0) {
        applyInteractionUpdate(state, {
          type: "tool-call-delta",
          callId: `call-${round - (round % 4)}`,
          taskUpdate: { type: "text-delta", text: `child ${round}` },
        });
      }
    }
    const message = state.messages.at(-1)!;
    expect(message.parts.length).toBeLessThanOrEqual(MAX_PARTS_PER_MESSAGE);
    const ids = sourcePartIds(state);
    expect(new Set(ids).size).toBe(ids.length);

    // The open text block is still found by id: the next delta continues it
    // (prose stays one block across interleaved reasoning) instead of opening
    // a new part or landing in a part that merely reuses an evicted id.
    const openId = state.openTextParts.get("text\u0000");
    const before = message.parts.length;
    applyInteractionUpdate(state, { type: "text-delta", text: " and more" });
    expect(message.parts.length).toBe(before);
    const open = message.parts.find((part) => part.sourcePartId === openId);
    expect(open?.type).toBe("text");
    expect(open?.content.endsWith("says 699 and more")).toBe(true);
  });

  test("a running child stays active after its launch card is trimmed away", () => {
    const state = running();
    const launch = { type: "task", args: { description: "Background", prompt: "p" } };
    applyInteractionUpdate(state, {
      type: "tool-call-started",
      callId: "launch",
      toolCall: launch,
    });
    applyInteractionUpdate(state, {
      type: "tool-call-completed",
      callId: "launch",
      toolCall: {
        ...launch,
        result: {
          status: "success",
          value: { isBackground: true, backgroundReason: "agentRequest", agentId: "a1" },
        },
      },
    });
    for (let index = 0; index < MAX_PARTS_PER_MESSAGE + 10; index += 1) {
      applyInteractionUpdate(state, { type: "thinking-delta", text: "t" });
      applyInteractionUpdate(state, { type: "thinking-completed" });
    }
    const cards = state.messages
      .flatMap((message) => message.parts)
      .filter((part): part is BridgeToolPart => part.type === "tool-invocation");
    expect(cards.find((part) => part.toolUseId === "launch")).toBeUndefined();
    // Display trimming is not evidence that the child stopped.
    expect(state.activeSubagentDescriptors.has("launch")).toBe(true);
    settleBackgroundChildren(state);
    expect(state.activeSubagentDescriptors.size).toBe(0);
  });

  test("a single text part never outgrows its own byte cap while streaming", () => {
    const state = running();
    for (let index = 0; index < 40; index += 1) {
      applyInteractionUpdate(state, { type: "text-delta", text: "y".repeat(128 * 1024) });
    }
    const part = state.messages[0]!.parts[0]!;
    // The cap plus the "[output truncated]" marker appended once it saturates.
    const notice = Buffer.byteLength("\n\n[output truncated]");
    expect(Buffer.byteLength(part.content)).toBeLessThanOrEqual(MAX_MESSAGE_TEXT_BYTES + notice);
  });
});

/** A background `task` launch whose child keeps running after the call returns. */
function launchBackgroundChild(state: SessionState, callId: string): void {
  const launch = {
    type: "task",
    args: { description: "Background", prompt: "p" },
  };
  applyInteractionUpdate(state, {
    type: "tool-call-started",
    callId,
    toolCall: launch,
  });
  applyInteractionUpdate(state, {
    type: "tool-call-completed",
    callId,
    toolCall: {
      ...launch,
      result: {
        status: "success",
        value: {
          isBackground: true,
          backgroundReason: "agentRequest",
          agentId: callId,
        },
      },
    },
  });
}

/** One update the child reports through its launch call. */
function nested(state: SessionState, parent: string, taskUpdate: Record<string, unknown>): void {
  applyInteractionUpdate(state, {
    type: "tool-call-delta",
    callId: parent,
    taskUpdate,
  });
}

function readCall(callId: string, content?: string): Record<string, unknown> {
  return {
    type: "read",
    args: { path: `${callId}.ts` },
    ...(content === undefined ? {} : { result: { status: "success", value: { content } } }),
  };
}

function childParts(state: SessionState, parent: string): BridgeMessagePart[] {
  return state.messages
    .flatMap((message) => message.parts)
    .filter((part) => "parentTaskUseId" in part && part.parentTaskUseId === parent);
}

function toolCard(state: SessionState, callId: string): BridgeToolPart | undefined {
  return state.messages
    .flatMap((message) => message.parts)
    .find(
      (part): part is BridgeToolPart =>
        part.type === "tool-invocation" && part.toolUseId === callId,
    );
}

describe("producer-side bounds for a sub-agent's nested activity", () => {
  test("a background child running many tools keeps its own window and its launch card", () => {
    const state = running();
    applyInteractionUpdate(state, {
      type: "text-delta",
      text: "Starting the child.",
    });
    launchBackgroundChild(state, "launch");
    for (let index = 0; index < 1_000; index += 1) {
      const callId = `child-${index}`;
      nested(state, "launch", {
        type: "tool-call-started",
        callId,
        toolCall: readCall(callId),
      });
      nested(state, "launch", {
        type: "tool-call-completed",
        callId,
        toolCall: readCall(callId, `contents ${index}`),
      });
      if (index % 10 === 0)
        nested(state, "launch", {
          type: "thinking-delta",
          text: `step ${index}`,
        });
      expect(childParts(state, "launch").length).toBeLessThanOrEqual(MAX_CHILD_PARTS_PER_TASK);
    }

    const message = state.messages.at(-1)!;
    // One chatty child no longer evicts the rest of its parent's message.
    expect(message.parts.length).toBeLessThan(MAX_PARTS_PER_MESSAGE);
    expect(message.parts[0]).toMatchObject({
      type: "text",
      content: "Starting the child.",
    });
    expect(toolCard(state, "launch")).toMatchObject({ agentState: "active" });
    expect(state.activeSubagentDescriptors.has("launch")).toBe(true);

    // Exactly one notice, placed before the child's retained steps.
    const children = childParts(state, "launch");
    const notices = children.filter((part) => part.content === CHILD_TRIM_NOTICE);
    expect(notices).toHaveLength(1);
    expect(children[0]!.content).toBe(CHILD_TRIM_NOTICE);
    expect(toolCard(state, "child-999")).toMatchObject({
      toolState: "success",
    });
    expect(state.transcriptTruncated).toBe(true);
    expect(state.droppedParts).toBeGreaterThan(0);
    const ids = sourcePartIds(state);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a child's retained bytes stay within its budget plus one check interval", () => {
    const state = running();
    launchBackgroundChild(state, "launch");
    const output = "é".repeat(128 * 1024); // 256 KiB of UTF-8.
    const largestUpdate = Buffer.byteLength(output) + 4096;
    const ceiling = MAX_CHILD_BYTES_PER_TASK + STREAM_BOUND_INTERVAL_BYTES + largestUpdate;
    const childBytes = () =>
      childParts(state, "launch").reduce(
        (total, part) => total + Buffer.byteLength(JSON.stringify(part)) + 1,
        0,
      );
    const updates = Math.ceil((MAX_CHILD_BYTES_PER_TASK * 2) / Buffer.byteLength(output));
    for (let index = 0; index < updates; index += 1) {
      const callId = `big-${index}`;
      nested(state, "launch", {
        type: "tool-call-completed",
        callId,
        toolCall: readCall(callId, output),
      });
      expect(childBytes()).toBeLessThanOrEqual(ceiling);
    }
    expect(childParts(state, "launch")[0]!.content).toBe(CHILD_TRIM_NOTICE);
    expect(toolCard(state, "launch")).toMatchObject({ agentState: "active" });
  });

  test("a running grandchild whose card was trimmed stays active and completes correctly", () => {
    const state = running();
    launchBackgroundChild(state, "launch");
    // The child launches its own sub-agent, then starts more calls than its
    // window holds, none of which settle: nothing here is safe to drop, so the
    // oldest live cards go — the grandchild's launch card first.
    const grandchild = {
      type: "task",
      args: { description: "Grandchild", prompt: "q" },
    };
    nested(state, "launch", {
      type: "tool-call-started",
      callId: "grandchild",
      toolCall: grandchild,
    });
    expect(toolCard(state, "grandchild")).toMatchObject({
      agentState: "active",
    });
    for (let index = 0; index < MAX_CHILD_PARTS_PER_TASK + 20; index += 1) {
      const callId = `pending-${index}`;
      nested(state, "launch", {
        type: "tool-call-started",
        callId,
        toolCall: readCall(callId),
      });
    }
    expect(toolCard(state, "grandchild")).toBeUndefined();
    expect(childParts(state, "launch").length).toBeLessThanOrEqual(MAX_CHILD_PARTS_PER_TASK);

    // Dropping a card is display-only: nothing was marked finished, the
    // grandchild is still tracked, and the session still reports work.
    expect(state.activeSubagentDescriptors.has("grandchild")).toBe(true);
    expect(sessionIsWorking(state)).toBe(true);
    for (const part of childParts(state, "launch")) {
      if (part.type === "tool-invocation") expect(part.toolState).toBe("pending");
    }

    // Its real completion still lands, on a card rebuilt from its own payload.
    nested(state, "launch", {
      type: "tool-call-completed",
      callId: "grandchild",
      toolCall: {
        ...grandchild,
        result: { status: "success", value: { agentId: "g1" } },
      },
    });
    expect(toolCard(state, "grandchild")).toMatchObject({
      toolState: "success",
      agentState: "finished",
      parentTaskUseId: "launch",
    });
    expect(state.activeSubagentDescriptors.has("grandchild")).toBe(false);
    expect(state.activeSubagentDescriptors.has("launch")).toBe(true);
  });

  test("a child's open block is live, so its own trims keep it and its prose continues", () => {
    const state = running();
    launchBackgroundChild(state, "launch");
    nested(state, "launch", { type: "text-delta", text: "child prose" });
    const openKey = "text\u0000launch";
    const open = state.openTextParts.get(openKey)!;
    for (let index = 0; index < MAX_CHILD_PARTS_PER_TASK + 5; index += 1) {
      nested(state, "launch", { type: "thinking-delta", text: `why ${index}` });
      nested(state, "launch", { type: "thinking-completed" });
    }
    expect(childParts(state, "launch").length).toBeLessThanOrEqual(MAX_CHILD_PARTS_PER_TASK);
    expect(childParts(state, "launch")[0]!.content).toBe(CHILD_TRIM_NOTICE);
    nested(state, "launch", { type: "text-delta", text: " continues" });
    expect(state.openTextParts.get(openKey)).toBe(open);
    const block = childParts(state, "launch").find((part) => part.sourcePartId === open);
    expect(block?.content).toBe("child prose continues");
  });

  test("a trim that evicts an open block forgets its lookup; the next delta opens a new one", () => {
    const state = running();
    applyInteractionUpdate(state, { type: "text-delta", text: "prose" });
    const openKey = "text\u0000";
    const first = state.openTextParts.get(openKey)!;
    for (let index = 0; index < MAX_PARTS_PER_MESSAGE + 5; index += 1) {
      applyInteractionUpdate(state, { type: "thinking-delta", text: "t" });
      applyInteractionUpdate(state, { type: "thinking-completed" });
    }
    expect(sourcePartIds(state)).not.toContain(first);
    expect(state.openTextParts.has(openKey)).toBe(false);
    applyInteractionUpdate(state, { type: "text-delta", text: "more" });
    expect(state.openTextParts.get(openKey)).not.toBe(first);
    expect(state.messages.at(-1)!.parts.at(-1)).toMatchObject({
      type: "text",
      content: "more",
    });
  });

  test("the bound's frequency, trims and worst duration are counted", () => {
    const state = running();
    launchBackgroundChild(state, "launch");
    let updates = 2;
    for (let index = 0; index < MAX_CHILD_PARTS_PER_TASK + 10; index += 1) {
      const callId = `c-${index}`;
      nested(state, "launch", {
        type: "tool-call-completed",
        callId,
        toolCall: readCall(callId, "x".repeat(16 * 1024)),
      });
      updates += 1;
    }
    const summary = transcriptBoundSummary(state);
    expect(summary.checks).toBe(updates);
    // One count check per new nested card, and at least one exact pass once
    // the charged growth crossed the interval.
    expect(summary.childChecks).toBe(MAX_CHILD_PARTS_PER_TASK + 10);
    expect(summary.exactChecks).toBeGreaterThan(0);
    expect(summary.trims).toBeGreaterThan(0);
    expect(summary.childPartsDropped).toBeGreaterThan(0);
    expect(summary.childPartsDropped).toBe(state.droppedParts);
    expect(Number.isFinite(summary.maxCheckMs)).toBe(true);
    expect(summary.maxCheckMs).toBeGreaterThanOrEqual(0);
    expect(summary.limits).toEqual({
      streamIntervalBytes: STREAM_BOUND_INTERVAL_BYTES,
      childParts: MAX_CHILD_PARTS_PER_TASK,
      childBytes: MAX_CHILD_BYTES_PER_TASK,
    });
  });
});

describe("nested arrays inside a single tool card", () => {
  test("a todo list is capped by count and item size, and says how much it dropped", () => {
    const state = running();
    const todos = Array.from({ length: MAX_TODO_ITEMS + 50 }, (_, index) => ({
      content: `${index} ${"t".repeat(8 * 1024)}`,
      status: "pending",
    }));
    applyInteractionUpdate(state, {
      type: "tool-call-completed",
      callId: "todos",
      toolCall: {
        type: "updateTodos",
        args: { todos },
        result: { status: "success", value: {} },
      },
    });
    const card = toolCard(state, "todos")!;
    const kept = card.toolArgs?.todos as Array<{ content: string }>;
    expect(kept).toHaveLength(MAX_TODO_ITEMS);
    expect(state.todos).toHaveLength(MAX_TODO_ITEMS);
    expect(card.toolArgs?.truncated).toBe("50 more todo items omitted");
    expect(Buffer.byteLength(JSON.stringify(card.toolArgs))).toBeLessThanOrEqual(
      MAX_TOOL_ARGUMENT_BYTES,
    );
  });

  test("argument arrays picked from the SDK payload are bounded like any argument", () => {
    const state = running();
    const paths = Array.from({ length: 20_000 }, (_, index) => `src/some/long/path/${index}.ts`);
    applyInteractionUpdate(state, {
      type: "tool-call-started",
      callId: "lints",
      toolCall: { type: "readLints", args: { paths } },
    });
    const card = toolCard(state, "lints")!;
    expect(Buffer.byteLength(JSON.stringify(card.toolArgs))).toBeLessThanOrEqual(
      MAX_TOOL_ARGUMENT_BYTES,
    );
    expect(String(card.toolArgs?.truncated)).toContain("Arguments omitted");
  });
});
