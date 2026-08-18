import { describe, test, expect } from "bun:test";
import { TurnAccumulator, unconfirmedTurnId } from "./turn-accumulator.js";
import type { EngineItem } from "../engine/types.js";
import {
  MAX_SUBAGENT_ACTION_OUTPUT_CHARS,
  SUBAGENT_OUTPUT_TRUNCATION_NOTICE,
} from "../subagent-transcript.js";

function accumulator(
  overrides: Partial<{ turnId: string; generation: number }> = {},
): TurnAccumulator {
  return new TurnAccumulator({
    threadId: "thread-1",
    turnId: overrides.turnId ?? "turn-1",
    engineGeneration: overrides.generation ?? 1,
    assistantMessageId: "assistant-1",
    requestId: "req-1",
  });
}

function agentMessage(id: string, text: string): EngineItem {
  return { id, type: "agent_message", text } as unknown as EngineItem;
}

function startPatch(turn: TurnAccumulator, id = "call-patch"): void {
  turn.onDynamicToolStarted({
    id,
    type: "dynamic_tool_call",
    tool: "apply_patch",
    arguments: "*** Begin Patch",
    content_items: [],
    status: "in_progress",
  });
}

describe("staleness guards", () => {
  test("rejects events from an older engine generation", () => {
    const turn = accumulator({ generation: 3 });
    // A restart happened; anything from generation 2 describes a dead process.
    expect(turn.accepts({ turnId: "turn-1", engineGeneration: 2 })).toBe(false);
    expect(turn.accepts({ turnId: "turn-1", engineGeneration: 3 })).toBe(true);
  });

  test("rejects events from a previous turn", () => {
    const turn = accumulator({ turnId: "turn-2" });
    expect(turn.accepts({ turnId: "turn-1", engineGeneration: 1 })).toBe(false);
    expect(turn.accepts({ turnId: "turn-2", engineGeneration: 1 })).toBe(true);
  });

  test("accepts events that omit the discriminators", () => {
    const turn = accumulator();
    expect(turn.accepts({})).toBe(true);
  });
});

describe("delta accumulation", () => {
  test("appends streamed agent text in order", () => {
    const turn = accumulator();
    turn.onTextDelta("item-1", "Hel");
    turn.onTextDelta("item-1", "lo w");
    turn.onTextDelta("item-1", "orld");

    expect(turn.effectiveText(turn.items.get("item-1")!)).toBe("Hello world");
  });

  test("a delta before item/started still creates the item in order", () => {
    const turn = accumulator();
    // app-server can deliver a delta before we have processed the start event.
    turn.onTextDelta("item-2", "early");
    turn.onItemStarted(agentMessage("item-1", ""));

    expect(turn.itemOrder).toEqual(["item-2", "item-1"]);
    expect(turn.effectiveText(turn.items.get("item-2")!)).toBe("early");
  });

  test("a steering boundary keeps earlier and later items in separate assistant segments", () => {
    const turn = accumulator();
    turn.onItemCompleted(agentMessage("before", "before steer"));

    const boundary = turn.freezeAssistantSegment();
    expect(turn.orderedForAssistantSegment().map((item) => item.id)).toEqual(["before"]);

    turn.onItemCompleted(agentMessage("after", "after steer"));
    // Events can keep arriving while the old segment is being flushed, but
    // they must not leak above the steering message.
    expect(turn.orderedForAssistantSegment().map((item) => item.id)).toEqual(["before"]);

    turn.startAssistantSegment("assistant-2", boundary);
    expect(turn.assistantMessageId).toBe("assistant-2");
    expect(turn.orderedForAssistantSegment().map((item) => item.id)).toEqual(["after"]);

    turn.onItemCompleted(agentMessage("before", "completed after steer"));
    expect(
      turn.orderedForAssistantSegment("assistant-1").map((item) => turn.effectiveText(item)),
    ).toEqual(["completed after steer"]);
  });

  test("an authoritative item order places delayed post-steer items below the steer", () => {
    const turn = accumulator();
    turn.onItemCompleted(agentMessage("before", "before"));
    turn.onItemCompleted(agentMessage("after", "after"));

    const boundary = turn.boundaryAfterItems({
      precedingItemIds: ["before"],
      followingItemIds: ["after"],
    });
    turn.freezeAssistantSegment(boundary, "2026-08-11T12:00:01.000Z");
    turn.startAssistantSegment("assistant-2", boundary, "2026-08-11T12:00:01.000Z");

    expect(turn.orderedForAssistantSegment("assistant-1").map((item) => item.id)).toEqual([
      "before",
    ]);
    expect(turn.orderedForAssistantSegment("assistant-2").map((item) => item.id)).toEqual([
      "after",
    ]);
  });

  describe("boundaryAfterItems", () => {
    test("keeps every live item above the steer when nothing is known to follow it", () => {
      // The regression this guards: `thread/read` projects only what app-server
      // has persisted, so an item still streaming is absent from the prefix. An
      // empty prefix used to collapse the pre-steer row to nothing and push the
      // whole in-flight response below the user's own steering message.
      const turn = accumulator();
      turn.onTextDelta("streaming", "half a thought");

      expect(turn.boundaryAfterItems({ precedingItemIds: [], followingItemIds: [] })).toBe(1);
      expect(turn.boundaryAfterItems({})).toBe(1);
      expect(turn.boundaryAfterItems(undefined)).toBe(1);
    });

    test("survives a truncated projection that omits the items before the steer", () => {
      const turn = accumulator();
      turn.onItemCompleted(agentMessage("elided-by-summary", "before"));
      turn.onItemCompleted(agentMessage("after", "after"));

      // A partial `itemsView` drops the prefix but cannot invent a suffix, so
      // the split still lands in the right place.
      expect(turn.boundaryAfterItems({ followingItemIds: ["after"] })).toBe(1);
    });

    test("ignores following ids that have not reached the accumulator yet", () => {
      const turn = accumulator();
      turn.onItemCompleted(agentMessage("before", "before"));

      expect(
        turn.boundaryAfterItems({
          precedingItemIds: ["before"],
          followingItemIds: ["not-yet-streamed"],
        }),
      ).toBe(1);
    });

    test("never reaches back into an already-frozen row", () => {
      const turn = accumulator();
      turn.onItemCompleted(agentMessage("first", "first"));
      turn.onItemCompleted(agentMessage("second", "second"));
      const first = turn.boundaryAfterItems({ followingItemIds: ["second"] });
      turn.freezeAssistantSegment(first);
      turn.startAssistantSegment("assistant-2", first);

      // A second steer whose projection names an item from the frozen row above
      // must not pull that row's contents back down into the live one.
      expect(turn.boundaryAfterItems({ followingItemIds: ["first", "second"] })).toBe(first);
    });
  });

  test("a segment version changes only while its own items are moving", () => {
    const turn = accumulator();
    turn.onItemStarted(agentMessage("first", ""));
    const boundary = turn.freezeAssistantSegment();
    turn.startAssistantSegment("assistant-2", boundary);
    turn.onItemStarted(agentMessage("second", ""));

    const frozen = turn.assistantSegmentVersion("assistant-1");
    turn.onItemCompleted(agentMessage("second", "live row moved"));
    expect(turn.assistantSegmentVersion("assistant-1")).toBe(frozen);

    turn.onItemCompleted(agentMessage("first", "frozen row moved"));
    expect(turn.assistantSegmentVersion("assistant-1")).toBeGreaterThan(frozen);
  });

  test("reasoning deltas accumulate per channel and index", () => {
    const turn = accumulator();
    turn.onReasoningDelta("r1", "sum-a", "summary", 0);
    turn.onReasoningDelta("r1", "sum-b", "summary", 0);
    turn.onReasoningDelta("r1", "second", "summary", 1);
    turn.onReasoningDelta("r1", "body", "content", 0);

    const reasoning = turn.effectiveReasoning(turn.items.get("r1")!);
    expect(reasoning.summary).toEqual(["sum-asum-b", "second"]);
    expect(reasoning.content).toEqual(["body"]);
  });

  test("a gap in reasoning indices does not shift later entries", () => {
    const turn = accumulator();
    turn.onReasoningDelta("r1", "third", "summary", 2);

    // Index 2 must stay at index 2 so it lines up with the authoritative item.
    expect(turn.effectiveReasoning(turn.items.get("r1")!).summary).toEqual(["", "", "third"]);
  });

  test("caps command output and records that it was truncated", () => {
    const turn = new TurnAccumulator({
      threadId: "thread-1",
      turnId: "turn-1",
      engineGeneration: 1,
      assistantMessageId: "m1",
      maxCommandOutputChars: 10,
    });

    turn.onCommandOutputDelta("cmd-1", "0123456789EXTRA");
    turn.onCommandOutputDelta("cmd-1", "more");

    const item = turn.items.get("cmd-1")!;
    // A runaway command must not be able to exhaust bridge memory.
    expect(item.outputDelta).toBe("0123456789");
    expect(item.outputTruncated).toBe(true);
  });
});

describe("item/completed is authoritative", () => {
  test("the final item replaces whatever deltas built", () => {
    const turn = accumulator();
    turn.onTextDelta("item-1", "partial strea");
    turn.onItemCompleted(agentMessage("item-1", "Complete final answer."));

    expect(turn.effectiveText(turn.items.get("item-1")!)).toBe("Complete final answer.");
  });

  test("a late delta after completion is ignored rather than appended", () => {
    const turn = accumulator();
    turn.onItemCompleted(agentMessage("item-1", "final"));
    turn.onTextDelta("item-1", " stray tail");

    // Otherwise a trailing delta would duplicate text onto the final answer.
    expect(turn.effectiveText(turn.items.get("item-1")!)).toBe("final");
  });

  test("completed without started is accepted", () => {
    const turn = accumulator();
    turn.onItemCompleted(agentMessage("item-1", "only event"));

    expect(turn.itemOrder).toEqual(["item-1"]);
    expect(turn.items.get("item-1")!.completed).toBe(true);
  });

  test("a raw failed patch remains visible until a structured item supersedes it", () => {
    const turn = accumulator();
    startPatch(turn);

    expect(
      turn.onDynamicToolOutput(
        "call-patch",
        "apply_patch verification failed: Failed to find expected lines",
      ),
    ).toBe(true);
    expect(turn.items.get("call-patch")?.item).toMatchObject({
      type: "dynamic_tool_call",
      tool: "apply_patch",
      arguments: "*** Begin Patch",
      status: "failed",
      content_items: [
        {
          type: "inputText",
          text: "apply_patch verification failed: Failed to find expected lines",
        },
      ],
    });

    turn.onItemCompleted({
      id: "call-patch",
      type: "file_change",
      changes: [{ path: "src/example.ts", kind: "update" }],
      status: "completed",
    });
    expect(turn.itemOrder).toEqual(["call-patch"]);
    expect(turn.items.get("call-patch")?.item).toMatchObject({
      type: "file_change",
      status: "completed",
    });
    expect(turn.items.get("call-patch")?.rawFallback).toBe(false);
  });

  test("a successful raw patch output completes without requesting an early publish", () => {
    const turn = accumulator();
    startPatch(turn);

    expect(turn.onDynamicToolOutput("call-patch", "Done!", 100)).toBe(false);
    expect(turn.items.get("call-patch")).toMatchObject({
      completed: true,
      completedAt: 100,
      item: {
        type: "dynamic_tool_call",
        tool: "apply_patch",
        status: "completed",
        content_items: [{ type: "inputText", text: "Done!" }],
      },
    });
  });

  test("an in-progress structured file change supersedes a completed raw fallback", () => {
    const turn = accumulator();
    startPatch(turn);
    turn.onDynamicToolOutput("call-patch", "Done!");

    turn.onItemUpdated({
      id: "call-patch",
      type: "file_change",
      changes: [{ path: "src/example.ts", kind: "update" }],
      status: "completed",
    });

    expect(turn.items.get("call-patch")).toMatchObject({
      completed: false,
      rawFallback: false,
      item: {
        type: "file_change",
        changes: [{ path: "src/example.ts", kind: "update" }],
      },
    });
  });

  test("a raw patch call arriving after the structured preview does not replace it", () => {
    const turn = accumulator();
    // app-server streams `item/fileChange/patchUpdated` while the model writes
    // the patch, then the raw `custom_tool_call` for the same call id lands.
    // Demoting to the raw item would also hide it, blanking the live preview
    // for as long as the patch takes to apply — including an approval wait.
    turn.onItemUpdated({
      id: "call-patch",
      type: "file_change",
      changes: [{ path: "src/example.ts", kind: "update" }],
      status: "in_progress",
    });
    startPatch(turn);

    expect(turn.items.get("call-patch")).toMatchObject({
      rawFallback: false,
      completed: false,
      item: { type: "file_change", status: "in_progress" },
    });
  });

  test("a raw patch call arriving after item/completed cannot un-complete it", () => {
    const turn = accumulator();
    turn.onItemCompleted({
      id: "call-patch",
      type: "file_change",
      changes: [{ path: "src/example.ts", kind: "update" }],
      status: "completed",
    });
    // Duplicate delivery is expected on reconnect, and may replay the raw call
    // and the in-progress preview *after* the authoritative completion.
    startPatch(turn);
    turn.onItemUpdated({
      id: "call-patch",
      type: "file_change",
      changes: [{ path: "src/example.ts", kind: "update" }],
      status: "in_progress",
    });

    expect(turn.items.get("call-patch")).toMatchObject({
      completed: true,
      rawFallback: false,
      item: { type: "file_change", status: "completed" },
    });
  });

  test("a repeated raw patch call still refreshes its own candidate", () => {
    const turn = accumulator();
    startPatch(turn);
    turn.onDynamicToolStarted({
      id: "call-patch",
      type: "dynamic_tool_call",
      tool: "apply_patch",
      arguments: "*** Begin Patch\n*** Add File: a.ts\n+a\n*** End Patch",
      content_items: [],
      status: "in_progress",
    });

    expect(turn.items.get("call-patch")).toMatchObject({
      rawFallback: true,
      item: { arguments: "*** Begin Patch\n*** Add File: a.ts\n+a\n*** End Patch" },
    });
    expect(turn.itemOrder).toEqual(["call-patch"]);
  });

  test.each([
    ["empty string", ""],
    ["undefined", undefined],
  ] as const)("an %s raw patch output completes without a content item", (_label, output) => {
    const turn = accumulator();
    startPatch(turn);

    expect(turn.onDynamicToolOutput("call-patch", output)).toBe(false);
    expect(turn.items.get("call-patch")?.item).toMatchObject({
      type: "dynamic_tool_call",
      status: "completed",
      content_items: [],
    });
  });

  test("a structured raw patch output is retained as readable JSON", () => {
    const turn = accumulator();
    startPatch(turn);

    expect(
      turn.onDynamicToolOutput("call-patch", {
        changed: ["src/example.ts"],
        count: 1,
      }),
    ).toBe(false);
    expect(turn.items.get("call-patch")?.item).toMatchObject({
      type: "dynamic_tool_call",
      status: "completed",
      content_items: [
        {
          type: "inputText",
          text: '{\n  "changed": [\n    "src/example.ts"\n  ],\n  "count": 1\n}',
        },
      ],
    });
  });

  test("a circular raw patch output falls back to a safe string representation", () => {
    const turn = accumulator();
    startPatch(turn);
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(turn.onDynamicToolOutput("call-patch", circular)).toBe(false);
    expect(turn.items.get("call-patch")?.item).toMatchObject({
      type: "dynamic_tool_call",
      status: "completed",
      content_items: [{ type: "inputText", text: "[object Object]" }],
    });
  });

  test("an oversized raw patch output is bounded and marked as truncated", () => {
    const turn = accumulator();
    startPatch(turn);
    const oversized = "x".repeat(MAX_SUBAGENT_ACTION_OUTPUT_CHARS + 1);

    expect(turn.onDynamicToolOutput("call-patch", oversized)).toBe(false);
    const item = turn.items.get("call-patch")?.item;
    expect(item).toMatchObject({
      type: "dynamic_tool_call",
      status: "completed",
    });
    if (item?.type !== "dynamic_tool_call") {
      throw new Error("expected a dynamic tool call");
    }
    const content = item.content_items[0];
    expect(content).toEqual({
      type: "inputText",
      text: "x".repeat(MAX_SUBAGENT_ACTION_OUTPUT_CHARS) + SUBAGENT_OUTPUT_TRUNCATION_NOTICE,
    });
  });

  test("duplicate raw patch outputs cannot overwrite the first completion", () => {
    const turn = accumulator();
    startPatch(turn);

    expect(turn.onDynamicToolOutput("call-patch", "Done!", 100)).toBe(false);
    expect(turn.onDynamicToolOutput("call-patch", "late conflicting output", 200)).toBe(false);

    expect(turn.itemOrder).toEqual(["call-patch"]);
    expect(turn.items.get("call-patch")?.completedAt).toBe(100);
    expect(turn.items.get("call-patch")?.item).toMatchObject({
      type: "dynamic_tool_call",
      status: "completed",
      content_items: [{ type: "inputText", text: "Done!" }],
    });
  });

  test("an unrelated raw output cannot create an orphan tool item", () => {
    const turn = accumulator();
    expect(turn.onDynamicToolOutput("unknown-call", "output")).toBe(false);
    expect(turn.itemOrder).toEqual([]);
  });

  test("raw custom output cannot overwrite another dynamic tool", () => {
    const turn = accumulator();
    turn.onItemStarted({
      id: "exec-1",
      type: "dynamic_tool_call",
      tool: "exec_command",
      arguments: { cmd: "true" },
      content_items: [],
      status: "in_progress",
    });

    expect(turn.onDynamicToolOutput("exec-1", "completed")).toBe(false);
    expect(turn.items.get("exec-1")?.item).toMatchObject({
      type: "dynamic_tool_call",
      tool: "exec_command",
      status: "in_progress",
    });
  });

  test("a repeated item/started does not reset streamed text", () => {
    const turn = accumulator();
    turn.onItemStarted(agentMessage("item-1", ""));
    turn.onTextDelta("item-1", "streamed");
    turn.onItemStarted(agentMessage("item-1", ""));

    expect(turn.effectiveText(turn.items.get("item-1")!)).toBe("streamed");
    expect(turn.itemOrder).toEqual(["item-1"]);
  });

  test("item/updated cannot overwrite an already-final item", () => {
    const turn = accumulator();
    turn.onItemCompleted(agentMessage("item-1", "final"));
    turn.onItemUpdated(agentMessage("item-1", "stale intermediate"));

    expect(turn.effectiveText(turn.items.get("item-1")!)).toBe("final");
  });

  test("duplicate completion is idempotent", () => {
    const turn = accumulator();
    turn.onItemCompleted(agentMessage("item-1", "final"), 100);
    turn.onItemCompleted(agentMessage("item-1", "final"), 200);

    expect(turn.itemOrder).toEqual(["item-1"]);
    // First timestamp wins, so retries do not move the clock forward.
    expect(turn.items.get("item-1")!.completedAt).toBe(100);
  });
});

describe("turn lifecycle", () => {
  test("builds and recognizes the unconfirmed turn id for a request", () => {
    const id = unconfirmedTurnId("request-123");
    const turn = accumulator({ turnId: id });

    expect(id).toBe("unconfirmed:request-123");
    expect(turn.isUnconfirmed()).toBe(true);
  });

  test("starts in starting and binds the real turn id when it arrives", () => {
    const turn = accumulator({ turnId: "provisional" });
    expect(turn.phase).toBe("starting");

    turn.markRunning("turn-real");
    expect(turn.phase).toBe("running");
    expect(turn.turnId).toBe("turn-real");
  });

  test("cancelling is not terminal, so no new turn may start", () => {
    const turn = accumulator();
    turn.markRunning();
    turn.markCancelling();

    expect(turn.phase).toBe("cancelling");
    expect(turn.isTerminal()).toBe(false);
  });

  test("cancelling cannot resurrect a finished turn", () => {
    const turn = accumulator();
    turn.complete("completed");
    turn.markCancelling();

    expect(turn.phase).toBe("completed");
  });

  test("interrupted and failed are terminal", () => {
    const interrupted = accumulator();
    interrupted.complete("interrupted");
    expect(interrupted.isTerminal()).toBe(true);

    const failed = accumulator();
    failed.complete("failed", { message: "model error" });
    expect(failed.isTerminal()).toBe(true);
    expect(failed.error?.message).toBe("model error");
  });

  test("an error notification is recorded without ending the turn", () => {
    const turn = accumulator();
    turn.markRunning();
    // app-server can report a retryable error and still complete the turn.
    turn.onError({ message: "transient upstream failure", retryable: true });

    expect(turn.phase).toBe("running");
    expect(turn.isTerminal()).toBe(false);
    expect(turn.error?.message).toBe("transient upstream failure");
  });

  test("partial output survives an interruption", () => {
    const turn = accumulator();
    turn.onTextDelta("item-1", "I was partway through");
    turn.complete("interrupted");

    // The user must keep what the agent had already produced.
    expect(turn.effectiveText(turn.items.get("item-1")!)).toBe("I was partway through");
  });

  test("records the turn diff", () => {
    const turn = accumulator();
    turn.onTurnDiff("diff --git a/x b/x");
    expect(turn.finalDiff).toBe("diff --git a/x b/x");
  });

  test("ordered() returns items in arrival order", () => {
    const turn = accumulator();
    turn.onItemStarted(agentMessage("a", ""));
    turn.onTextDelta("b", "x");
    turn.onItemCompleted(agentMessage("c", "done"));

    expect(turn.ordered().map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });
});
