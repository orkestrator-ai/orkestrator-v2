/**
 * How a command still `in_progress` renders once its turn has ended: left
 * running, with no tool state, never "running..." (to-do 7522).
 */
import { describe, expect, test } from "bun:test";
import { TurnAccumulator } from "../sessions/turn-accumulator.js";
import { commandExecutionParts } from "./normalization.js";
import { createTurnRenderState, effectiveItem, renderTurn } from "./render-turn.js";

function turn() {
  return new TurnAccumulator({
    threadId: "thread-1",
    turnId: "turn-1",
    engineGeneration: 1,
    assistantMessageId: "message-1",
    startedAt: "2026-11-06T10:00:00.000Z",
  });
}

function running(id = "cmd-1") {
  return {
    id,
    type: "command_execution" as const,
    command: "sleep 20; echo done",
    aggregated_output: "",
    status: "in_progress" as const,
  };
}

function render(accumulator: TurnAccumulator, state = createTurnRenderState()) {
  return renderTurn(accumulator, {
    threadId: "thread-1",
    cwd: "/tmp",
    state,
    loadSubagentParts: async () => [],
  });
}

describe("commandExecutionParts", () => {
  test("a command left running carries the flag and no tool state", () => {
    const [part] = commandExecutionParts({ ...running(), left_running: true });
    expect(part).toMatchObject({ toolUseId: "cmd-1", toolName: "bash", toolLeftRunning: true });
    expect(part?.toolState).toBeUndefined();
  });

  test("a reported end wins over the flag", () => {
    const [completed] = commandExecutionParts({
      ...running(),
      status: "completed",
      exit_code: 0,
      left_running: true,
    });
    expect(completed).toMatchObject({ toolState: "success" });
    expect(completed?.toolLeftRunning).toBeUndefined();
    const [failed] = commandExecutionParts({ ...running(), status: "failed", left_running: true });
    expect(failed).toMatchObject({ toolState: "failure" });
    expect(failed?.toolLeftRunning).toBeUndefined();
  });

  test("a command still running in a live turn stays pending", () => {
    const [part] = commandExecutionParts(running());
    expect(part).toMatchObject({ toolState: "pending" });
    expect(part?.toolLeftRunning).toBeUndefined();
  });
});

describe("a terminal turn's unfinished command", () => {
  test("effectiveItem marks it left running only once the turn has ended", () => {
    const accumulator = turn();
    accumulator.onItemStarted(running());
    const entry = accumulator.items.get("cmd-1")!;
    expect(effectiveItem(accumulator, entry)).not.toHaveProperty("left_running");

    accumulator.complete("completed");
    expect(effectiveItem(accumulator, entry)).toMatchObject({ left_running: true });
  });

  test("streamed output is kept on the settled card", async () => {
    const accumulator = turn();
    accumulator.onItemStarted(running());
    accumulator.onCommandOutputDelta("cmd-1", "listening on :3000\n");
    accumulator.complete("completed");
    const { parts } = await render(accumulator);
    expect(parts).toMatchObject([
      { toolUseId: "cmd-1", toolLeftRunning: true, toolOutput: "listening on :3000\n" },
    ]);
  });

  test("a completed-while-running item is not served from the live render's cache", async () => {
    const accumulator = turn();
    accumulator.onItemStarted(running());
    accumulator.onItemCompleted(running());
    const state = createTurnRenderState();
    expect((await render(accumulator, state)).parts[0]).toMatchObject({ toolState: "pending" });

    accumulator.complete("completed");
    const settled = (await render(accumulator, state)).parts[0];
    expect(settled).toMatchObject({ toolLeftRunning: true });
    expect(settled?.toolState).toBeUndefined();
    // And the settled render is what the cache keeps from then on.
    expect((await render(accumulator, state)).parts[0]).toBe(settled);
  });

  test("an ended attempt the turn continues after (a capacity retry) stays pending", async () => {
    const accumulator = turn();
    accumulator.onItemStarted(running());
    accumulator.settleEndedAttempt();
    const { parts } = await render(accumulator);
    expect(parts[0]).toMatchObject({ toolState: "pending" });
    expect(parts[0]?.toolLeftRunning).toBeUndefined();
  });

  test("the turn's end moves the row of a completed-while-running command", () => {
    const accumulator = turn();
    accumulator.onItemStarted(running());
    accumulator.onItemCompleted(running());
    const before = accumulator.items.get("cmd-1")!.version;
    accumulator.complete("completed");
    expect(accumulator.items.get("cmd-1")!.version).toBeGreaterThan(before);
  });
});
