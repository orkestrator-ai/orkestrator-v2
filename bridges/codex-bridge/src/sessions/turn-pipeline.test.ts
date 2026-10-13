/**
 * Synthetic app-server notification sequences driven through the real reducer,
 * accumulator, renderer and structured-output parser — the same path a live
 * turn takes, minus the process. Sequences mirror what codex 0.162.1 was seen
 * to emit (see `docs/development/upgrade-agents.md`).
 */
import { describe, expect, test } from "bun:test";
import { reduceNotification } from "../app-server/event-reducer.js";
import { parseCodexStructuredOutput } from "../app-server-runtime-base.js";
import { createTurnRenderState, renderTurn } from "../messages/render-turn.js";
import { TurnAccumulator } from "./turn-accumulator.js";

const THREAD = "thread-1";
const TURN = "turn-1";

function newTurn(options: { structured?: boolean } = {}): TurnAccumulator {
  return new TurnAccumulator({
    threadId: THREAD,
    turnId: TURN,
    requestId: "request-1",
    engineGeneration: 1,
    assistantMessageId: "assistant-1",
    expectsStructuredOutput: options.structured ?? false,
    startedAt: "2026-10-13T12:00:00.000Z",
  });
}

/** Reduces one notification and applies it the way the runtime's lifecycle does. */
function deliver(turn: TurnAccumulator, method: string, params: Record<string, unknown>): void {
  const { events } = reduceNotification(
    { kind: "notification", method, params: { threadId: THREAD, turnId: TURN, ...params } },
    1,
  );
  for (const event of events) {
    if (!("turnId" in event) || !turn.accepts(event)) continue;
    switch (event.kind) {
      case "item.started":
        turn.onItemStarted(event.item, event.startedAtMs);
        break;
      case "item.updated":
        turn.onItemUpdated(event.item);
        break;
      case "item.completed":
        turn.onItemCompleted(event.item, event.completedAtMs);
        break;
      case "item.text.delta":
        turn.onTextDelta(event.itemId, event.delta);
        break;
      case "turn.completed":
        turn.complete(event.status, event.error);
        break;
      default:
        break;
    }
  }
}

function agentMessage(id: string, phase: string | null, text = ""): Record<string, unknown> {
  return {
    item: {
      type: "agentMessage",
      id,
      text,
      phase,
      memoryCitation: null,
      delivery: null,
      questions: null,
    },
  };
}

function completeTurn(turn: TurnAccumulator, status = "completed"): void {
  deliver(turn, "turn/completed", { turn: { id: TURN, status, items: [], error: null } });
}

async function render(turn: TurnAccumulator) {
  return renderTurn(turn, {
    threadId: THREAD,
    cwd: "/tmp",
    state: createTurnRenderState(),
    loadSubagentParts: async () => [],
  });
}

describe("instant_interrupt: a steer cuts the in-flight answer off", () => {
  /**
   * Observed against codex 0.162.1: the cut-off message gets `item/started`
   * (already phased `final_answer`) and deltas, but never `item/completed`;
   * the replacement answer is a new item, and `thread/read` omits the first.
   */
  function steeredTurn(options: { structured?: boolean; cutOff: string; replacement: string }) {
    const turn = newTurn(options);
    turn.markRunning(TURN);
    deliver(turn, "item/started", agentMessage("msg-cut", "final_answer"));
    deliver(turn, "item/agentMessage/delta", { itemId: "msg-cut", delta: options.cutOff });
    // The steer's own userMessage item is not rendered and changes nothing here.
    deliver(turn, "item/started", {
      item: { type: "userMessage", id: "steer", clientId: null, content: [] },
    });
    deliver(turn, "item/started", agentMessage("msg-new", "final_answer"));
    deliver(turn, "item/agentMessage/delta", { itemId: "msg-new", delta: options.replacement });
    deliver(turn, "item/completed", agentMessage("msg-new", "final_answer", options.replacement));
    return turn;
  }

  test("the replacement answer settles the cut-off one as interrupted", () => {
    const turn = steeredTurn({ cutOff: "Lighthouses occupy a", replacement: "PINEAPPLE" });
    const cut = turn.items.get("msg-cut")!;
    expect(cut.interrupted).toBe(true);
    expect(cut.item).toMatchObject({ type: "agent_message", interrupted: true });
    expect(turn.effectiveText(cut)).toBe("Lighthouses occupy a");
  });

  test("the cut-off text stays visible, and the replacement is the message body", async () => {
    const turn = steeredTurn({ cutOff: "Lighthouses occupy a", replacement: "PINEAPPLE" });
    completeTurn(turn);
    const rendered = await render(turn);
    expect(rendered.parts.map((part) => [part.type, part.content])).toEqual([
      ["text", "Lighthouses occupy a"],
      ["text", "PINEAPPLE"],
    ]);
    expect(rendered.content).toBe("PINEAPPLE");
  });

  test("a cut-off fragment is never the turn's structured output", async () => {
    const turn = steeredTurn({
      structured: true,
      cutOff: '{"answer":"stale"}',
      replacement: '{"answer":"fresh"}',
    });
    completeTurn(turn);
    expect(parseCodexStructuredOutput(turn)).toMatchObject({
      ok: true,
      value: { answer: "fresh" },
    });
    // The fragment is a draft: withheld from the transcript, like any other.
    const rendered = await render(turn);
    expect(rendered.parts.map((part) => part.content)).toEqual(['{"answer":"fresh"}']);
  });

  test("a turn that ends with the fragment still open settles it rather than parsing it", () => {
    const turn = newTurn({ structured: true });
    turn.markRunning(TURN);
    deliver(turn, "item/started", agentMessage("msg-cut", "final_answer"));
    deliver(turn, "item/agentMessage/delta", { itemId: "msg-cut", delta: '{"answer":"ok"}' });
    completeTurn(turn);

    expect(turn.items.get("msg-cut")!.interrupted).toBe(true);
    // Even valid JSON: app-server never completed it, so it is not an answer.
    expect(parseCodexStructuredOutput(turn)).toMatchObject({
      ok: false,
      error: { code: "malformed_output" },
    });
  });

  test("a delta-only message, never started, is settled the same way", async () => {
    const turn = newTurn();
    turn.markRunning(TURN);
    deliver(turn, "item/agentMessage/delta", { itemId: "msg-cut", delta: "early text" });
    deliver(turn, "item/started", agentMessage("msg-new", "final_answer"));
    deliver(turn, "item/completed", agentMessage("msg-new", "final_answer", "done"));
    completeTurn(turn);

    expect(turn.items.get("msg-cut")!.interrupted).toBe(true);
    expect((await render(turn)).parts.map((part) => part.content)).toEqual(["early text", "done"]);
  });

  test("a message cut off before it said anything leaves no empty row", async () => {
    const turn = newTurn();
    turn.markRunning(TURN);
    deliver(turn, "item/started", agentMessage("msg-cut", "final_answer"));
    deliver(turn, "item/started", agentMessage("msg-new", "final_answer"));
    deliver(turn, "item/completed", agentMessage("msg-new", "final_answer", "done"));
    completeTurn(turn);

    expect((await render(turn)).parts.map((part) => part.content)).toEqual(["done"]);
  });

  test("a late item/completed for the cut-off message is still authoritative", async () => {
    const turn = steeredTurn({ cutOff: "Light", replacement: "PINEAPPLE" });
    deliver(turn, "item/agentMessage/delta", { itemId: "msg-cut", delta: " ignored" });
    expect(turn.effectiveText(turn.items.get("msg-cut")!)).toBe("Light");

    deliver(turn, "item/completed", agentMessage("msg-cut", "final_answer", "Lighthouses."));
    completeTurn(turn);
    const cut = turn.items.get("msg-cut")!;
    expect(cut.interrupted).toBe(false);
    expect(cut.item).not.toHaveProperty("interrupted");
    expect((await render(turn)).parts.map((part) => part.content)).toEqual([
      "Lighthouses.",
      "PINEAPPLE",
    ]);
  });

  test("completed messages are untouched by later messages and by turn completion", () => {
    const turn = newTurn();
    turn.markRunning(TURN);
    deliver(turn, "item/started", agentMessage("first", "commentary"));
    deliver(turn, "item/agentMessage/delta", { itemId: "first", delta: "Looking." });
    deliver(turn, "item/completed", agentMessage("first", "commentary", "Looking."));
    deliver(turn, "item/started", agentMessage("second", "final_answer"));
    deliver(turn, "item/completed", agentMessage("second", "final_answer", "Done."));
    completeTurn(turn);

    for (const id of ["first", "second"]) {
      expect(turn.items.get(id)!.interrupted).toBeUndefined();
      expect(turn.items.get(id)!.item).not.toHaveProperty("interrupted");
    }
  });
});

describe("partial_answer (codex 0.162)", () => {
  test("is shown as answer text but never parsed as the final output", async () => {
    const turn = newTurn({ structured: true });
    turn.markRunning(TURN);
    deliver(turn, "item/completed", agentMessage("partial", "partial_answer", "Working on it."));
    deliver(turn, "item/completed", agentMessage("final", "final_answer", '{"answer":42}'));
    completeTurn(turn);

    expect(parseCodexStructuredOutput(turn)).toMatchObject({ ok: true, value: { answer: 42 } });
    expect((await render(turn)).parts.map((part) => part.content)).toEqual([
      "Working on it.",
      '{"answer":42}',
    ]);
  });

  test("a turn with only a partial answer has no structured result", () => {
    const turn = newTurn({ structured: true });
    turn.markRunning(TURN);
    deliver(turn, "item/completed", agentMessage("partial", "partial_answer", '{"answer":1}'));
    completeTurn(turn);

    expect(parseCodexStructuredOutput(turn)).toMatchObject({
      ok: false,
      error: { code: "malformed_output" },
    });
  });
});

describe("tool durations", () => {
  const started = 1_760_000_000_000;

  test("a finished call without its own duration is measured between app-server's clocks", async () => {
    const turn = newTurn();
    turn.markRunning(TURN);
    const fileChange = {
      type: "fileChange",
      id: "patch-1",
      changes: [],
      status: "inProgress",
    };
    deliver(turn, "item/started", { startedAtMs: started, item: fileChange });
    deliver(turn, "item/started", {
      startedAtMs: started,
      item: {
        type: "webSearch",
        id: "search-1",
        query: "lighthouses",
        action: null,
        results: null,
      },
    });
    const running = await render(turn);
    expect(running.parts.some((part) => part.toolDurationMs !== undefined)).toBe(false);

    deliver(turn, "item/completed", {
      completedAtMs: started + 1_500,
      item: {
        type: "webSearch",
        id: "search-1",
        query: "lighthouses",
        action: null,
        results: null,
      },
    });
    deliver(turn, "item/completed", {
      completedAtMs: started + 250,
      item: { ...fileChange, status: "completed" },
    });
    const rendered = await render(turn);
    expect(rendered.parts.find((part) => part.toolUseId === "search-1")?.toolDurationMs).toBe(
      1_500,
    );
  });

  test("app-server's own duration wins over the measured gap", async () => {
    const turn = newTurn();
    turn.markRunning(TURN);
    const command = {
      type: "commandExecution",
      id: "cmd-1",
      command: "sleep 1",
      cwd: "/tmp",
      processId: null,
      source: "agent",
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
    };
    deliver(turn, "item/started", {
      startedAtMs: started,
      item: { ...command, status: "inProgress", durationMs: null },
    });
    deliver(turn, "item/completed", {
      completedAtMs: started + 1_200,
      item: { ...command, status: "completed", exitCode: 0, durationMs: 1_003 },
    });
    const [part] = (await render(turn)).parts;
    expect(part).toMatchObject({ toolName: "bash", toolDurationMs: 1_003 });
  });

  test("history without lifecycle clocks reports no duration", async () => {
    const turn = newTurn();
    turn.markRunning(TURN);
    deliver(turn, "item/completed", {
      item: { type: "webSearch", id: "search-1", query: "q", action: null, results: null },
    });
    const [part] = (await render(turn)).parts;
    expect(part).not.toHaveProperty("toolDurationMs");
  });

  test("a plan row is not a tool call, so it gets no measured duration", async () => {
    const turn = newTurn();
    turn.markRunning(TURN);
    deliver(turn, "item/started", {
      startedAtMs: started,
      item: { type: "plan", id: "plan-1", text: "1. Do it" },
    });
    deliver(turn, "item/completed", {
      completedAtMs: started + 900,
      item: { type: "plan", id: "plan-1", text: "1. Do it" },
    });
    const [part] = (await render(turn)).parts;
    expect(part).toMatchObject({ toolName: "plan" });
    expect(part).not.toHaveProperty("toolDurationMs");
  });
});
