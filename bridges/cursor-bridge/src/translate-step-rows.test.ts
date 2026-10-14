/**
 * One transcript row per model step.
 *
 * A whole turn used to accumulate into one row. A turn can run for hours, and
 * a multi-megabyte row fits no transcript window, so readers could only show
 * a front-trimmed copy of it and lost its start for good once newer rows
 * pushed it out of the live tail. These tests pin the split and, above all,
 * that anything patching a call later finds the row that holds it.
 */
import { describe, expect, test } from "bun:test";
import { newSessionState } from "./agent-session.js";
import { MAX_CHILD_BYTES_PER_TASK, MAX_CHILD_PARTS_PER_TASK, MAX_MESSAGES } from "./config.js";
import type { BridgeMessage, BridgeMessagePart, BridgeToolPart, SessionState } from "./state.js";
import {
  beginAssistantTurn,
  boundTranscript,
  CHILD_TRIM_NOTICE,
  setMaxIndexedCallsForTests,
  STREAM_BOUND_INTERVAL_BYTES,
  turnStartIndex,
} from "./transcript.js";
import { applyInteractionUpdate } from "./translate.js";

function running(): SessionState {
  const state = newSessionState();
  state.status = "running";
  beginAssistantTurn(state);
  return state;
}

function apply(state: SessionState, update: Record<string, unknown>): void {
  applyInteractionUpdate(state, update);
}

function nested(state: SessionState, parent: string, taskUpdate: Record<string, unknown>): void {
  apply(state, { type: "tool-call-delta", callId: parent, modelCallId: "m1", taskUpdate });
}

function step(state: SessionState, stepId: number): void {
  apply(state, { type: "step-started", stepId });
}

function cards(row: BridgeMessage): BridgeToolPart[] {
  return row.parts.filter((part): part is BridgeToolPart => part.type === "tool-invocation");
}

function rowHolding(state: SessionState, callId: string): BridgeMessage[] {
  return state.messages.filter((row) => cards(row).some((part) => part.toolUseId === callId));
}

function childParts(row: BridgeMessage, parent: string): BridgeMessagePart[] {
  return row.parts.filter((part) => "parentTaskUseId" in part && part.parentTaskUseId === parent);
}

const shell = (command: string, stdout?: string) => ({
  type: "shell",
  args: { command },
  ...(stdout === undefined
    ? {}
    : {
        result: {
          status: "success",
          value: { exitCode: 0, signal: "", stdout, stderr: "", executionTime: 1 },
        },
      }),
});

const backgroundTask = (result?: boolean) => ({
  type: "task",
  args: { description: "Background", prompt: "p" },
  ...(result
    ? {
        result: {
          status: "success",
          value: { isBackground: true, backgroundReason: "agentRequest", agentId: "a1" },
        },
      }
    : {}),
});

describe("one row per model step", () => {
  test("a multi-step turn writes each step to a row of its own", () => {
    const state = running();
    step(state, 1);
    apply(state, { type: "thinking-delta", text: "plan" });
    apply(state, { type: "text-delta", text: "Reading the file." });
    apply(state, {
      type: "tool-call-started",
      callId: "read-1",
      modelCallId: "m1",
      toolCall: { type: "read", args: { path: "a.ts" } },
    });
    apply(state, { type: "step-completed", stepId: 1, stepDurationMs: 5 });
    step(state, 2);
    apply(state, { type: "text-delta", text: "It exports one function." });

    expect(state.messages).toHaveLength(2);
    const [first, second] = state.messages as [BridgeMessage, BridgeMessage];
    expect(first.parts.map((part) => part.type)).toEqual(["thinking", "text", "tool-invocation"]);
    expect(first.content).toBe("Reading the file.");
    expect(second).toMatchObject({ role: "assistant", content: "It exports one function." });
    expect(second.id).not.toBe(first.id);
    // Part ids name their own row, so nothing keyed on them collides.
    for (const row of state.messages) {
      for (const part of row.parts) expect(part.sourceMessageId).toBe(row.id);
    }
  });

  test("a boundary reported twice, or with nothing after it, leaves no empty row", () => {
    const state = running();
    step(state, 1);
    apply(state, { type: "text-delta", text: "one" });
    apply(state, { type: "turn-ended", usage: { inputTokens: 1, outputTokens: 1 } });
    step(state, 2);
    step(state, 3);
    apply(state, { type: "text-delta", text: "two" });
    apply(state, { type: "turn-ended", usage: { inputTokens: 1, outputTokens: 1 } });

    expect(state.messages.map((row) => row.content)).toEqual(["one", "two"]);
    expect(state.messages.every((row) => row.parts.length > 0)).toBe(true);
  });

  test("turn-ended alone still ends a step's row", () => {
    const state = running();
    apply(state, { type: "text-delta", text: "first call" });
    apply(state, { type: "turn-ended", usage: { inputTokens: 1, outputTokens: 1 } });
    apply(state, { type: "text-delta", text: "second call" });

    expect(state.messages.map((row) => row.content)).toEqual(["first call", "second call"]);
  });

  test("a sub-agent's own steps do not split its parent's row", () => {
    const state = running();
    apply(state, { type: "text-delta", text: "Launching." });
    apply(state, {
      type: "tool-call-started",
      callId: "launch",
      modelCallId: "m1",
      toolCall: backgroundTask(),
    });
    nested(state, "launch", { type: "step-started", stepId: 1 });
    nested(state, "launch", { type: "text-delta", text: "child" });
    apply(state, { type: "text-delta", text: " Still here." });

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.content).toBe("Launching. Still here.");
  });

  test("a step's prose does not continue into the next step's row", () => {
    const state = running();
    apply(state, { type: "text-delta", text: "before" });
    step(state, 2);
    apply(state, { type: "text-delta", text: "after" });

    const [first, second] = state.messages as [BridgeMessage, BridgeMessage];
    expect(first.parts).toEqual([expect.objectContaining({ type: "text", content: "before" })]);
    expect(second.parts).toEqual([expect.objectContaining({ type: "text", content: "after" })]);
  });
});

describe("late updates find the row that holds the call", () => {
  test("a completion lands on its earlier row without a duplicate card", () => {
    const state = running();
    apply(state, {
      type: "tool-call-started",
      callId: "read-1",
      modelCallId: "m1",
      toolCall: { type: "read", args: { path: "a.ts" } },
    });
    step(state, 2);
    apply(state, { type: "text-delta", text: "Meanwhile" });
    const revision = state.revision;
    apply(state, {
      type: "tool-call-completed",
      callId: "read-1",
      modelCallId: "m1",
      toolCall: {
        type: "read",
        args: { path: "a.ts" },
        result: { status: "success", value: { content: "body" } },
      },
    });

    expect(state.messages).toHaveLength(2);
    expect(rowHolding(state, "read-1")).toEqual([state.messages[0]!]);
    expect(cards(state.messages[0]!)).toEqual([
      expect.objectContaining({ toolUseId: "read-1", toolState: "success" }),
    ]);
    // Visible to a reader: the transcript token is the revision.
    expect(state.revision).toBeGreaterThan(revision);

    // The prose being written now is not cut by a card that sits above it.
    apply(state, { type: "text-delta", text: " more" });
    expect(state.messages[1]!.parts).toEqual([
      expect.objectContaining({ type: "text", content: "Meanwhile more" }),
    ]);
  });

  test("a completion after the boundary but before any new content opens no row", () => {
    const state = running();
    apply(state, {
      type: "tool-call-started",
      callId: "read-1",
      modelCallId: "m1",
      toolCall: { type: "read", args: { path: "a.ts" } },
    });
    step(state, 2);
    apply(state, {
      type: "tool-call-completed",
      callId: "read-1",
      modelCallId: "m1",
      toolCall: { type: "read", args: { path: "a.ts" } },
    });
    expect(state.messages).toHaveLength(1);
  });

  test("shell output streams into a command an earlier step started", () => {
    const state = running();
    apply(state, {
      type: "tool-call-started",
      callId: "sh-1",
      modelCallId: "m1",
      toolCall: shell("npm test"),
    });
    step(state, 2);
    apply(state, { type: "text-delta", text: "Waiting on the tests." });
    apply(state, { type: "shell-output-delta", event: { text: "1 passing\n" } });

    const [first, second] = state.messages as [BridgeMessage, BridgeMessage];
    expect(cards(first)[0]).toMatchObject({ toolUseId: "sh-1", toolOutput: "1 passing\n" });
    expect(first.parts.find((part) => part.type === "progress")).toMatchObject({
      toolUseId: "sh-1",
      content: "1 passing",
      sourceMessageId: first.id,
    });
    expect(second.parts.some((part) => part.type === "progress")).toBe(false);

    // Settling it clears the progress line from the row it sits on.
    apply(state, {
      type: "tool-call-completed",
      callId: "sh-1",
      modelCallId: "m1",
      toolCall: shell("npm test", "1 passing\n"),
    });
    expect(first.parts.some((part) => part.type === "progress")).toBe(false);
    expect(rowHolding(state, "sh-1")).toEqual([first]);
  });

  test("a delta still goes nowhere when the newest shell card has settled", () => {
    const state = running();
    apply(state, {
      type: "tool-call-completed",
      callId: "sh-1",
      modelCallId: "m1",
      toolCall: shell("ls", "a\n"),
    });
    step(state, 2);
    apply(state, { type: "shell-output-delta", event: { text: "stray" } });
    expect(state.messages).toHaveLength(1);
    expect(cards(state.messages[0]!)[0]!.toolOutput).toBe("a\n");
  });

  test("a compaction opened in one step settles there after a boundary", () => {
    const state = running();
    apply(state, { type: "text-delta", text: "long context" });
    apply(state, { type: "summary-started" });
    step(state, 2);
    apply(state, { type: "summary-completed", summary: "condensed" });

    expect(state.messages).toHaveLength(1);
    const compactions = state.messages[0]!.parts.filter((part) => part.type === "compaction");
    expect(compactions).toEqual([
      expect.objectContaining({ content: "condensed", toolState: "success" }),
    ]);
  });

  test("a steer between steps does not hide the turn's earlier rows", () => {
    const state = running();
    apply(state, {
      type: "tool-call-started",
      callId: "read-1",
      modelCallId: "m1",
      toolCall: { type: "read", args: { path: "a.ts" } },
    });
    apply(state, {
      type: "user-message-appended",
      userMessage: { type: "user_message", text: "also check b.ts" },
    });
    apply(state, { type: "text-delta", text: "Will do." });
    apply(state, {
      type: "tool-call-completed",
      callId: "read-1",
      modelCallId: "m1",
      toolCall: { type: "read", args: { path: "a.ts" } },
    });

    expect(state.messages.map((row) => row.role)).toEqual(["assistant", "user", "assistant"]);
    expect(rowHolding(state, "read-1")).toEqual([state.messages[0]!]);
    expect(cards(state.messages[0]!)[0]!.toolState).toBe("success");
  });

  test("a new turn cannot patch the previous turn's rows", () => {
    const state = running();
    apply(state, {
      type: "tool-call-started",
      callId: "call-1",
      modelCallId: "m1",
      toolCall: { type: "read", args: { path: "a.ts" } },
    });
    beginAssistantTurn(state);
    apply(state, {
      type: "tool-call-started",
      callId: "call-1",
      modelCallId: "m1",
      toolCall: { type: "read", args: { path: "b.ts" } },
    });
    expect(state.messages).toHaveLength(2);
    expect(rowHolding(state, "call-1")).toHaveLength(2);
  });
});

describe("a sub-agent's activity stays on its launch card's row", () => {
  function launchInFirstStep(state: SessionState): BridgeMessage {
    apply(state, { type: "text-delta", text: "Starting the child." });
    apply(state, {
      type: "tool-call-started",
      callId: "launch",
      modelCallId: "m1",
      toolCall: backgroundTask(),
    });
    apply(state, {
      type: "tool-call-completed",
      callId: "launch",
      modelCallId: "m1",
      toolCall: backgroundTask(true),
    });
    step(state, 2);
    apply(state, { type: "text-delta", text: "Parent carries on." });
    return state.messages[0]!;
  }

  test("child prose and tools land beside the launch card, not on the newest row", () => {
    const state = running();
    const owner = launchInFirstStep(state);
    nested(state, "launch", { type: "text-delta", text: "child " });
    nested(state, "launch", {
      type: "tool-call-started",
      callId: "child-read",
      modelCallId: "m2",
      toolCall: { type: "read", args: { path: "c.ts" } },
    });
    step(state, 3);
    apply(state, { type: "text-delta", text: "Third step." });
    nested(state, "launch", {
      type: "tool-call-completed",
      callId: "child-read",
      modelCallId: "m2",
      toolCall: { type: "read", args: { path: "c.ts" } },
    });

    expect(state.messages).toHaveLength(3);
    expect(childParts(owner, "launch").map((part) => part.type)).toEqual([
      "text",
      "tool-invocation",
    ]);
    expect(rowHolding(state, "child-read")).toEqual([owner]);
    expect(cards(owner).find((part) => part.toolUseId === "child-read")?.toolState).toBe("success");
    for (const row of state.messages.slice(1)) expect(childParts(row, "launch")).toEqual([]);
    // Child prose never joins the parent's body.
    expect(owner.content).toBe("Starting the child.");
  });

  test("a child's prose block continues across its parent's step boundaries", () => {
    const state = running();
    const owner = launchInFirstStep(state);
    nested(state, "launch", { type: "text-delta", text: "child prose" });
    step(state, 3);
    apply(state, { type: "text-delta", text: "Parent again." });
    nested(state, "launch", { type: "text-delta", text: " continues" });

    expect(childParts(owner, "launch")).toEqual([
      expect.objectContaining({ type: "text", content: "child prose continues" }),
    ]);
  });

  test("the per-child count bound applies to the launch card's row", () => {
    const state = running();
    const owner = launchInFirstStep(state);
    for (let index = 0; index < MAX_CHILD_PARTS_PER_TASK + 40; index += 1) {
      const callId = `child-${index}`;
      nested(state, "launch", {
        type: "tool-call-completed",
        callId,
        modelCallId: "m2",
        toolCall: { type: "read", args: { path: `${callId}.ts` } },
      });
      expect(childParts(owner, "launch").length).toBeLessThanOrEqual(MAX_CHILD_PARTS_PER_TASK);
    }
    expect(childParts(owner, "launch")[0]!.content).toBe(CHILD_TRIM_NOTICE);
    expect(cards(owner)[0]).toMatchObject({ toolUseId: "launch", agentState: "active" });
    expect(state.messages.at(-1)!.content).toBe("Parent carries on.");
  });

  test("the per-child byte bound applies to the launch card's row", () => {
    const state = running();
    const owner = launchInFirstStep(state);
    const output = "é".repeat(128 * 1024);
    const ceiling =
      MAX_CHILD_BYTES_PER_TASK + STREAM_BOUND_INTERVAL_BYTES + Buffer.byteLength(output) + 4096;
    const childBytes = () =>
      childParts(owner, "launch").reduce(
        (total, part) => total + Buffer.byteLength(JSON.stringify(part)) + 1,
        0,
      );
    const updates = Math.ceil((MAX_CHILD_BYTES_PER_TASK * 2) / Buffer.byteLength(output));
    for (let index = 0; index < updates; index += 1) {
      const callId = `big-${index}`;
      nested(state, "launch", {
        type: "tool-call-completed",
        callId,
        modelCallId: "m2",
        toolCall: {
          type: "read",
          args: { path: `${callId}.ts` },
          result: { status: "success", value: { content: output } },
        },
      });
      expect(childBytes()).toBeLessThanOrEqual(ceiling);
    }
    boundTranscript(state);
    expect(childBytes()).toBeLessThanOrEqual(MAX_CHILD_BYTES_PER_TASK);
    expect(childParts(owner, "launch")[0]!.content).toBe(CHILD_TRIM_NOTICE);
  });
});

describe("lookups across a long turn stay bounded", () => {
  /**
   * Count reads of `state.messages` entries and of every existing row's parts.
   * Installed after the setup so only the work under test is counted.
   */
  function countReads(state: SessionState): {
    rows: () => number;
    parts: (except?: BridgeMessage) => number;
  } {
    let rowReads = 0;
    const partReads = new Map<BridgeMessage, number>();
    const isIndex = (key: string | symbol) => typeof key === "string" && /^\d+$/.test(key);
    for (const row of state.messages) {
      row.parts = new Proxy(row.parts, {
        get(target, key, receiver) {
          if (isIndex(key)) partReads.set(row, (partReads.get(row) ?? 0) + 1);
          return Reflect.get(target, key, receiver);
        },
      });
    }
    state.messages = new Proxy(state.messages, {
      get(target, key, receiver) {
        if (isIndex(key)) rowReads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    // A new array is a transcript replaced, so the turn's start is measured
    // once more; that one walk is the proxy's doing, not the lookups'.
    turnStartIndex(state);
    rowReads = 0;
    return {
      rows: () => rowReads,
      parts: (except) =>
        [...partReads].reduce((total, [row, reads]) => (row === except ? total : total + reads), 0),
    };
  }

  function readCall(callId: string, settled = false): Record<string, unknown> {
    return {
      type: settled ? "tool-call-completed" : "tool-call-started",
      callId,
      modelCallId: "m",
      toolCall: { type: "read", args: { path: `${callId}.ts` } },
    };
  }

  /** A turn of `steps` rows, each holding prose and `calls` cards. */
  function longTurn(steps: number, calls: number): SessionState {
    const state = running();
    for (let index = 0; index < steps; index += 1) {
      step(state, index);
      apply(state, { type: "text-delta", text: `step ${index}` });
      for (let call = 0; call < calls; call += 1) apply(state, readCall(`c${index}-${call}`));
    }
    return state;
  }

  test("a new call reads none of the turn's earlier rows", () => {
    const state = longTurn(300, 4);
    step(state, 300);
    const reads = countReads(state);

    for (let index = 0; index < 50; index += 1) apply(state, readCall(`fresh-${index}`));

    // The scan this replaced read every row and every card per call:
    // 300 rows and 1,200 cards, fifty times over.
    expect(reads.parts()).toBe(0);
    expect(reads.rows()).toBeLessThan(50 * 16);
    expect(rowHolding(state, "fresh-49")).toEqual([state.messages.at(-1)!]);
  });

  test("a late result reads only the row holding its call", () => {
    const state = longTurn(300, 4);
    const early = state.messages.find((row) => row.content === "step 3")!;
    step(state, 300);
    apply(state, { type: "text-delta", text: "later" });
    const reads = countReads(state);

    apply(state, readCall("c3-1", true));

    expect(reads.parts(early)).toBe(0);
    expect(reads.rows()).toBeLessThan(16);
    expect(rowHolding(state, "c3-1")).toEqual([early]);
    expect(cards(early).find((part) => part.toolUseId === "c3-1")!.toolState).toBe("success");
  });

  test("a sub-agent's output finds its row without searching the transcript", () => {
    const state = running();
    apply(state, {
      type: "tool-call-started",
      callId: "launch",
      modelCallId: "m1",
      toolCall: backgroundTask(),
    });
    const owner = state.messages.at(-1)!;
    for (let index = 0; index < 300; index += 1) {
      step(state, index);
      apply(state, { type: "text-delta", text: `step ${index}` });
    }
    // The first token looks the row up; the rest reuse it.
    nested(state, "launch", { type: "text-delta", text: "child " });
    const reads = countReads(state);
    const lastIndexOf = state.messages.lastIndexOf;
    let searches = 0;
    state.messages.lastIndexOf = function (...args) {
      searches += 1;
      return lastIndexOf.apply(this, args);
    };

    for (let index = 0; index < 100; index += 1) {
      nested(state, "launch", { type: "text-delta", text: "token " });
    }

    // A handful of reads per token, however long the turn: the search this
    // replaced read all 301 rows for every one.
    expect(searches).toBe(0);
    expect(reads.rows()).toBeLessThan(100 * 16);
    expect(childParts(owner, "launch").map((part) => part.content)).toEqual([
      `child ${"token ".repeat(100)}`,
    ]);
  });

  test("past the call index's cap, lookups fall back to the scan and stay exact", () => {
    setMaxIndexedCallsForTests(8);
    try {
      const state = longTurn(30, 1);
      const holders = Array.from({ length: 30 }, (_, index) => rowHolding(state, `c${index}-0`));
      for (let index = 0; index < 30; index += 1) apply(state, readCall(`c${index}-0`, true));
      for (let index = 0; index < 30; index += 1) {
        expect(rowHolding(state, `c${index}-0`)).toEqual(holders[index]!);
      }
      expect(cards(state.messages.at(-1)!)).toHaveLength(1);
    } finally {
      setMaxIndexedCallsForTests(undefined);
    }
  });

  test("the call index keeps late results exact across trims", () => {
    const state = running();
    // More steps than the transcript retains, so the turn's oldest rows go.
    const steps = MAX_MESSAGES + 50;
    for (let index = 0; index < steps; index += 1) {
      step(state, index);
      apply(state, readCall(`c${index}`));
    }
    boundTranscript(state);
    expect(state.messages.length).toBeLessThanOrEqual(MAX_MESSAGES);

    // A retained call settles on its own card.
    const retained = `c${steps - 10}`;
    const holder = rowHolding(state, retained);
    apply(state, readCall(retained, true));
    expect(rowHolding(state, retained)).toEqual(holder);

    // A trimmed one has no card left, so it gets one on the current row, once.
    apply(state, readCall("c0", true));
    apply(state, readCall("c0", true));
    expect(rowHolding(state, "c0")).toEqual([state.messages.at(-1)!]);
    expect(cards(state.messages.at(-1)!).filter((part) => part.toolUseId === "c0")).toHaveLength(1);
  });
});
