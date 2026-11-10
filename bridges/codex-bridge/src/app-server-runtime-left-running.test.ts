/**
 * A command still running when its turn ends is settled as "left running".
 *
 * A unified-exec process the model does not wait for (a dev server, a watcher,
 * `sleep 20; echo done` with a one-second yield) outlives its `exec_command`
 * call. app-server reports nothing for it after `turn/completed`, so a card
 * left at `pending` read "running..." on an idle thread for good. The row that
 * holds it is rendered again when the turn ends, however far back it is, and
 * the card carries `toolLeftRunning` with no tool state (to-do 7522).
 */
import { describe, expect, test } from "bun:test";
import { MAX_TRACKED_ASSISTANT_ROWS } from "./app-server-runtime-base.js";
import type { NormalizedMessage, NormalizedPart } from "./messages/types.js";
import { harness, type Harness } from "./app-server-runtime-test-harness.js";

const TURN_STARTED_MS = Date.parse("2026-11-06T10:00:00.000Z");

async function startTurn(): Promise<{ h: Harness; sessionId: string }> {
  const h = await harness();
  const { sessionId } = h.runtime.createSession({ mode: "build" });
  await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });
  return { h, sessionId };
}

function notifyItem(
  h: Harness,
  method: "item/started" | "item/completed",
  item: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): void {
  h.child().notify(method, { threadId: "thread-1", turnId: "turn-1", item, ...extra });
}

function command(id: string, status: "inProgress" | "completed"): Record<string, unknown> {
  return {
    id,
    type: "commandExecution",
    command: `run ${id}`,
    aggregatedOutput: status === "completed" ? `output of ${id}` : null,
    status,
    source: "unifiedExecStartup",
    ...(status === "completed" ? { exitCode: 0 } : {}),
  };
}

/** One model response: it reasons, then starts a command. */
function response(h: Harness, step: number, options: { completeCommand?: boolean } = {}): void {
  const reasoning = { id: `r${step}`, type: "reasoning", summary: [`step ${step}`], content: [] };
  notifyItem(h, "item/started", reasoning, { startedAtMs: TURN_STARTED_MS + step * 1_000 });
  notifyItem(h, "item/completed", reasoning);
  notifyItem(h, "item/started", command(`c${step}`, "inProgress"));
  if (options.completeCommand ?? true) {
    notifyItem(h, "item/completed", command(`c${step}`, "completed"));
  }
}

function endTurn(h: Harness, status: "completed" | "interrupted" = "completed"): void {
  const answer = { id: "answer", type: "agentMessage", text: "Started it" };
  notifyItem(h, "item/started", answer, { startedAtMs: TURN_STARTED_MS + 60_000 });
  notifyItem(h, "item/completed", answer);
  h.child().notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status } });
}

async function assistantRows(h: Harness, sessionId: string): Promise<NormalizedMessage[]> {
  return (await h.runtime.getMessages(sessionId))!.filter(
    (message) => message.role === "assistant",
  );
}

function call(rows: NormalizedMessage[], toolUseId: string): NormalizedPart | undefined {
  for (const row of rows) {
    const part = row.parts.find((candidate) => candidate.toolUseId === toolUseId);
    if (part) return part;
  }
  return undefined;
}

function patchesFor(h: Harness, messageId: string, from: number) {
  return h.events
    .slice(from)
    .filter(
      (event) =>
        event.type === "message.patched" &&
        (event.data as { messageId?: string }).messageId === messageId,
    );
}

describe("a command still running when its turn ends", () => {
  test("reads running while the turn runs, and left running once it has ended", async () => {
    const { h, sessionId } = await startTurn();
    response(h, 1, { completeCommand: false });
    h.child().notify("item/commandExecution/outputDelta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "c1",
      delta: "booting",
    });
    await h.drain();
    expect(call(await assistantRows(h, sessionId), "c1")).toMatchObject({ toolState: "pending" });

    endTurn(h);
    await h.drain();

    const settled = call(await assistantRows(h, sessionId), "c1");
    expect(settled).toMatchObject({
      toolName: "bash",
      toolLeftRunning: true,
      // What it printed before the turn ended is kept.
      toolOutput: "booting",
    });
    expect(settled?.toolState).toBeUndefined();
    expect(h.runtime.getStatus(sessionId)).toMatchObject({ phase: "idle" });
  });

  test("a row past the tracking bound is published again when the turn ends", async () => {
    const { h, sessionId } = await startTurn();
    response(h, 1, { completeCommand: false });
    for (let step = 2; step <= MAX_TRACKED_ASSISTANT_ROWS + 4; step += 1) response(h, step);
    await h.drain();
    const first = (await assistantRows(h, sessionId))[0]!;
    expect(call([first], "c1")).toMatchObject({ toolState: "pending" });

    const before = h.events.length;
    endTurn(h);
    await h.drain();

    const rows = await assistantRows(h, sessionId);
    expect(rows[0]?.id).toBe(first.id);
    expect(call([rows[0]!], "c1")).toMatchObject({ toolLeftRunning: true });
    expect(call([rows[0]!], "c1")?.toolState).toBeUndefined();
    // Readers holding the row learn of it: the frozen row is patched.
    expect(patchesFor(h, first.id, before)).toHaveLength(1);
    // Commands that finished keep their outcome.
    expect(call(rows, "c2")).toMatchObject({ toolState: "success" });
    expect(call(rows, "c2")?.toolLeftRunning).toBeUndefined();
  });

  test("a command app-server completed while still in progress is settled the same way", async () => {
    const { h, sessionId } = await startTurn();
    response(h, 1, { completeCommand: false });
    notifyItem(h, "item/completed", command("c1", "inProgress"));
    // Past the tracking bound, so only the turn's end can reach its row.
    for (let step = 2; step <= MAX_TRACKED_ASSISTANT_ROWS + 4; step += 1) response(h, step);
    await h.drain();
    expect(call(await assistantRows(h, sessionId), "c1")).toMatchObject({ toolState: "pending" });

    endTurn(h);
    await h.drain();
    const settled = call(await assistantRows(h, sessionId), "c1");
    expect(settled).toMatchObject({ toolLeftRunning: true });
    expect(settled?.toolState).toBeUndefined();
  });

  test("an interrupted turn does not leave a spinner either", async () => {
    const { h, sessionId } = await startTurn();
    response(h, 1, { completeCommand: false });
    await h.drain();
    endTurn(h, "interrupted");
    await h.drain();
    const settled = call(await assistantRows(h, sessionId), "c1");
    expect(settled).toMatchObject({ toolLeftRunning: true });
    expect(settled?.toolState).toBeUndefined();
  });
});
