import { describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedMessage } from "./messages/types.js";
import { harness, threadPayload, type Harness } from "./app-server-runtime-test-harness.js";

/**
 * A code-mode cell the sandbox refused has no app-server item; the runtime
 * reads it from the rollout app-server named for the thread
 * (`RefusedCellTail`). The watch is driven by hand, so nothing waits on real
 * file events.
 */

const TURN_STARTED_MS = Date.parse("2026-10-17T14:53:40.000Z");
const TOUCH = 'text(await tools.exec_command({cmd:"touch coordinator-live-shell.txt"}));';
const REFUSED_TOUCH =
  '{"exit_code":1,"output":"touch: coordinator-live-shell.txt: Operation not permitted\\n"}';

function rolloutRecord(ms: number, payload: Record<string, unknown>): string {
  return `${JSON.stringify({
    timestamp: new Date(TURN_STARTED_MS + ms).toISOString(),
    type: "response_item",
    payload: { ...payload, internal_chat_message_metadata_passthrough: { turn_id: "turn-1" } },
  })}\n`;
}

function refusedCell(callId: string, ms: number): string {
  return (
    rolloutRecord(ms, {
      type: "custom_tool_call",
      call_id: callId,
      name: "exec",
      input: TOUCH,
      status: "completed",
    }) +
    rolloutRecord(ms + 100, {
      type: "custom_tool_call_output",
      call_id: callId,
      output: [
        { type: "input_text", text: "Script completed\nOutput:\n" },
        { type: "input_text", text: REFUSED_TOUCH },
      ],
    })
  );
}

async function startTurn(): Promise<{
  h: Harness;
  sessionId: string;
  rollout: string;
  changed: () => Promise<void>;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "refused-cells-runtime-"));
  const rollout = join(root, "rollout-2026-10-17T14-53-40-thread-1.jsonl");
  // What an earlier turn left, which the new turn's tail must skip.
  await writeFile(rollout, refusedCell("earlier-cell", -60_000));
  let onChange: (() => void) | undefined;
  const h = await harness(
    { "thread/start": () => ({ thread: threadPayload("thread-1", { path: rollout }) }) },
    {
      watchRolloutFile: (_path, listener) => {
        onChange = listener;
        return { close: () => (onChange = undefined) };
      },
    },
  );
  const { sessionId } = h.runtime.createSession({ mode: "build" });
  await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });
  h.child().notify("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
  await h.drain();
  return {
    h,
    sessionId,
    rollout,
    changed: async () => {
      onChange?.();
      await h.drain();
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function notifyItem(
  h: Harness,
  method: "item/started" | "item/completed",
  item: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): void {
  h.child().notify(method, { threadId: "thread-1", turnId: "turn-1", item, ...extra });
}

function reasoning(h: Harness, id: string, ms: number): void {
  const item = { id, type: "reasoning", summary: [id], content: [] };
  notifyItem(h, "item/started", item, { startedAtMs: TURN_STARTED_MS + ms });
  notifyItem(h, "item/completed", item);
}

function finish(h: Harness, ms: number): void {
  const answer = { id: "answer", type: "agentMessage", text: "create, edit and shell were denied" };
  notifyItem(h, "item/started", answer, { startedAtMs: TURN_STARTED_MS + ms });
  notifyItem(h, "item/completed", answer);
  h.child().notify("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "completed" },
  });
}

async function assistantRows(h: Harness, sessionId: string): Promise<NormalizedMessage[]> {
  return (await h.runtime.getMessages(sessionId))!.filter(
    (message) => message.role === "assistant",
  );
}

describe("refused code-mode cells", () => {
  test("a refused cell shows in the row that ran it, and the next response opens its own", async () => {
    const { h, sessionId, rollout, changed, cleanup } = await startTurn();
    try {
      reasoning(h, "r1", 1_000);
      await h.drain();
      // Codex writes the cell's output before it asks for the next response.
      await appendFile(rollout, refusedCell("call-touch", 2_000));
      await changed();
      reasoning(h, "r2", 4_000);
      finish(h, 5_000);
      await h.drain();

      const rows = await assistantRows(h, sessionId);
      expect(rows.map((row) => row.parts.map((part) => part.toolUseId ?? part.type))).toEqual([
        ["thinking", "call-touch"],
        ["thinking", "text"],
      ]);
      const part = rows[0]!.parts.find((candidate) => candidate.toolUseId === "call-touch");
      expect(part).toMatchObject({
        type: "tool-invocation",
        toolName: "exec",
        toolState: "failure",
        toolArgs: { input: TOUCH },
      });
      expect(part?.toolError).toContain("Operation not permitted");
    } finally {
      await cleanup();
    }
  });

  test("a cell the watch never reported is read when the turn ends", async () => {
    const { h, sessionId, rollout, cleanup } = await startTurn();
    try {
      reasoning(h, "r1", 1_000);
      await appendFile(rollout, refusedCell("call-touch", 2_000));
      finish(h, 5_000);
      await h.drain();

      const rows = await assistantRows(h, sessionId);
      const ids = rows.flatMap((row) => row.parts.map((part) => part.toolUseId ?? part.type));
      expect(ids).toContain("call-touch");
      expect(ids).not.toContain("earlier-cell");
    } finally {
      await cleanup();
    }
  });
});
