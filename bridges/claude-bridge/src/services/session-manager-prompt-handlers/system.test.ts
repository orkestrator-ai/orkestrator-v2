import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, test } from "bun:test";
import { handleSystemMessage } from "./system.js";
import { turnFixture } from "./turn-fixture.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/**
 * A turn whose result has arrived while it still owed an inherited
 * continuation: reaching the shared tail (`finishTurnInputIfSettled`) is what
 * clears `inheritedContinuation`, so the flag shows whether a frame did.
 */
function settledTurn() {
  const fixture = turnFixture();
  cleanups.push(fixture.dispose);
  fixture.session.latestTurnGeneration = fixture.turn.turnGeneration;
  fixture.turn.receivedResult = true;
  fixture.turn.inheritedContinuation = true;
  return fixture;
}

describe("system message handling", () => {
  test.each([
    [
      "an invalid task notification",
      { subtype: "task_notification", task_id: "t", status: "lost" },
      true,
    ],
    ["a task notification without an id", { subtype: "task_notification" }, false],
    ["a task edge without an id", { subtype: "task_progress" }, false],
    ["a level signal without a task list", { subtype: "background_tasks_changed" }, false],
    ["an empty memory recall", { subtype: "memory_recall", memories: [] }, false],
    ["a subtype newer than the table", { subtype: "invented_later" }, false],
  ])("%s: skips the shared tail = %p", async (_name, fields, stops) => {
    const { turn } = settledTurn();
    await handleSystemMessage(turn, { type: "system", ...fields } as unknown as SDKMessage);
    expect(turn.inheritedContinuation).toBe(stops);
  });

  test("a subtype newer than the table is counted as drift and kept as a notice", async () => {
    const { session, turn } = settledTurn();
    await handleSystemMessage(turn, {
      type: "system",
      subtype: "invented_later",
      message: "said something",
    } as unknown as SDKMessage);
    expect(session.health?.drift()?.unknownKinds).toEqual(["system:invented_later"]);
  });

  test("an API retry opens a pending row and settles the one before it", async () => {
    const { session, turn } = settledTurn();
    const retry = (attempt: number) =>
      handleSystemMessage(turn, {
        type: "system",
        subtype: "api_retry",
        attempt,
        error_status: 529,
      } as unknown as SDKMessage);
    await retry(1);
    await retry(2);
    expect(session.messages.map((row) => [row.parts[0]?.type, row.parts[0]?.toolState])).toEqual([
      ["retry", "failure"],
      ["retry", "pending"],
    ]);
    expect(turn.stream.pendingApiRetryMessageId).toBe(session.messages[1]!.id);
  });
});
