import { describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexRuntimeLifecycle } from "./app-server-runtime-lifecycle.js";
import { TurnAccumulator } from "./sessions/turn-accumulator.js";
import type { CodexRuntimeContext } from "./app-server-runtime-context.js";
import { hydrateMessagesFromPersistedSession } from "./history/rollout.js";
import type { NormalizedMessage } from "./messages/types.js";
import {
  deferredSignal,
  harness,
  threadPayload,
  type Harness,
} from "./app-server-runtime-test-harness.js";

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

function rolloutRecord(ms: number, payload: Record<string, unknown>, turnId = "turn-1"): string {
  return `${JSON.stringify({
    timestamp: new Date(TURN_STARTED_MS + ms).toISOString(),
    type: "response_item",
    payload: {
      ...payload,
      turn_id: turnId,
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    },
  })}\n`;
}

function refusedCell(callId: string, ms: number, turnId = "turn-1"): string {
  return (
    rolloutRecord(
      ms,
      {
        type: "custom_tool_call",
        call_id: callId,
        name: "exec",
        input: TOUCH,
        status: "completed",
      },
      turnId,
    ) +
    rolloutRecord(
      ms + 100,
      {
        type: "custom_tool_call_output",
        call_id: callId,
        output: [
          { type: "input_text", text: "Script completed\nOutput:\n" },
          { type: "input_text", text: REFUSED_TOUCH },
        ],
      },
      turnId,
    )
  );
}

async function startTurn(fast = false): Promise<{
  h: Harness;
  sessionId: string;
  rollout: string;
  changed: () => Promise<void>;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "refused-cells-runtime-"));
  await mkdir(join(root, "sessions"));
  const rollout = join(root, "sessions", "rollout-2026-10-17T14-53-40-thread-1.jsonl");
  // What an earlier turn left, which the new turn's tail must skip.
  await writeFile(
    rollout,
    JSON.stringify({ type: "session_meta", payload: { id: "thread-1", cwd: "/tmp/ws" } }) +
      "\n" +
      refusedCell("earlier-cell", -60_000, "turn-0"),
  );
  let onChange: (() => void) | undefined;
  const h = await harness(
    {
      "thread/start": () => ({ thread: threadPayload("thread-1", { path: rollout }) }),
      "turn/start": async () => {
        if (fast) {
          // These notifications are parked until dispatch and session persistence finish.
          h.child().notify("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
          reasoning(h, "r1", 1_000);
          await appendFile(rollout, refusedCell("call-touch", 2_000));
          reasoning(h, "r2", 4_000);
          finish(h, 5_000);
        }
        return { turn: { id: "turn-1" } };
      },
    },
    {
      watchRolloutFile: (_path, listener) => {
        onChange = listener;
        return { close: () => (onChange = undefined) };
      },
    },
  );
  const { sessionId } = h.runtime.createSession({ mode: "build" });
  await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });
  if (!fast) h.child().notify("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
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

function internals(h: Harness): { context: CodexRuntimeContext; lifecycle: CodexRuntimeLifecycle } {
  return h.runtime as unknown as { context: CodexRuntimeContext; lifecycle: CodexRuntimeLifecycle };
}

const visibleRows = (rows: NormalizedMessage[]) =>
  rows.map((row) => ({ ...row, parts: row.parts.filter((part) => part.type !== "thinking") }));

const rowParts = (rows: NormalizedMessage[]) =>
  rows.map((row) => row.parts.map((part) => part.toolUseId ?? part.type));

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
  test("cells written before parked turn.started and completed are recovered exactly once", async () => {
    const { h, sessionId, cleanup } = await startTurn(true);
    try {
      const rows = await assistantRows(h, sessionId);
      expect(rowParts(rows)).toEqual([
        ["thinking", "call-touch"],
        ["thinking", "text"],
      ]);
      expect(h.runtime.getStatus(sessionId)).toMatchObject({ status: "idle" });
    } finally {
      await cleanup();
    }
  });

  test("the dispatch boundary is spent by its own turn, not left for a later review", async () => {
    const { h, cleanup } = await startTurn();
    try {
      const state = internals(h).context.threadState.get("thread-1")!;
      expect(state.refusedCellTail?.turnId).toBe("turn-1");
      expect(state.refusedCellOffset).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  test("a slow read precedes the following response and agrees with a reload", async () => {
    const { h, sessionId, rollout, cleanup } = await startTurn();
    const gate = deferredSignal();
    try {
      reasoning(h, "r1", 1_000);
      await h.drain();
      await appendFile(
        rollout,
        rolloutRecord(1_000, {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "r1" }],
        }) +
          refusedCell("call-touch", 2_000) +
          rolloutRecord(4_000, {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "r2" }],
          }) +
          rolloutRecord(5_000, {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "create, edit and shell were denied" }],
          }),
      );
      const state = internals(h).context.threadState.get("thread-1")!;
      const tail = state.refusedCellTail!.tail;
      const reader = tail as unknown as { readAppended: () => Promise<void> };
      const read = reader.readAppended.bind(reader);
      reader.readAppended = async () => {
        await gate.promise;
        await read();
      };
      reasoning(h, "r2", 4_000);
      finish(h, 5_000);
      await h.engine.getSupervisor().notificationQueue.drainAll();
      // The transport consumed every notification while this thread waited on disk.
      expect(internals(h).context.registry.getThread("thread-1")!.activeTurn!.items.has("r2")).toBe(
        false,
      );
      gate.resolve();
      await h.drain();
      const live = await assistantRows(h, sessionId);
      expect(rowParts(live)).toEqual([
        ["thinking", "call-touch"],
        ["thinking", "text"],
      ]);
      const previousHome = process.env.CODEX_HOME;
      process.env.CODEX_HOME = join(rollout, "..", "..");
      try {
        const reloaded = await hydrateMessagesFromPersistedSession("thread-1");
        expect(
          rowParts(
            reloaded.messages.filter((row) => row.role === "assistant" && row.turnId === "turn-1"),
          ),
        ).toEqual(rowParts(visibleRows(live)));
      } finally {
        process.env.CODEX_HOME = previousHome;
      }
    } finally {
      gate.resolve();
      await cleanup();
    }
  });

  test.each(["release", "detach", "stop", "cancel", "recovery", "generation", "replacement"])(
    "%s during a read prevents late cells",
    async (action) => {
      const { h, sessionId, rollout, cleanup } = await startTurn();
      const gate = deferredSignal();
      try {
        const { context, lifecycle } = internals(h);
        const thread = context.registry.getThread("thread-1")!;
        const state = context.threadState.get("thread-1")!;
        const entry = state.refusedCellTail!;
        const reader = entry.tail as unknown as { readAppended: () => Promise<void> };
        const read = reader.readAppended.bind(reader);
        reader.readAppended = async () => {
          await gate.promise;
          await read();
        };
        await appendFile(rollout, refusedCell("late", 2_000));
        const reading = entry.tail.poll();
        let stopped: Promise<void> | undefined;
        if (action === "release") lifecycle.releaseThreadRuntimeState("thread-1");
        else if (action === "detach") stopped = lifecycle.detachThread(thread);
        else if (action === "stop") stopped = h.runtime.stop();
        else if (action === "cancel") {
          stopped = h.runtime.abort(sessionId).then(() => undefined);
          await h.child().waitForRequest("turn/interrupt");
          h.child().notify("turn/completed", {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "interrupted" },
          });
        } else if (action === "recovery") {
          lifecycle.onEngineEvent({
            kind: "engine.state",
            state: "restarting",
          });
        } else if (action === "generation") {
          const oldTurn = thread.activeTurn!;
          thread.engineGeneration += 1;
          thread.activeTurn = new TurnAccumulator({
            threadId: thread.threadId,
            turnId: "turn-2",
            engineGeneration: thread.engineGeneration,
            assistantMessageId: oldTurn.assistantMessageId,
          });
          lifecycle.startRefusedCellTail(thread, thread.activeTurn);
          lifecycle.applyRefusedCell(thread, oldTurn, {
            callId: "stale-generation",
            source: TOUCH,
            output: REFUSED_TOUCH,
            failed: true,
          });
        } else {
          thread.activeTurn = null;
          lifecycle.applyRefusedCell(thread, { turnId: "stale" } as never, {
            callId: "direct-stale",
            source: TOUCH,
            output: REFUSED_TOUCH,
            failed: true,
          });
          entry.turnId = "another-turn";
          expect(
            lifecycle.takeRefusedCellTail("thread-1", { turnId: "turn-1" } as never),
          ).toBeUndefined();
        }
        gate.resolve();
        await reading;
        await stopped;
        expect(entry.cells).toEqual([]);
        expect(entry.tail.busy()).toBeUndefined();
        expect(
          (await assistantRows(h, sessionId))
            .flatMap((row) => row.parts)
            .some((part) => part.toolUseId === "late"),
        ).toBe(false);
      } finally {
        gate.resolve();
        await cleanup();
      }
    },
  );
  test("disk backpressure keeps authoritative events and tells inactive readers to reconcile", async () => {
    const { h, sessionId, cleanup } = await startTurn();
    const gate = deferredSignal();
    try {
      reasoning(h, "r1", 1_000);
      await h.drain();
      const { context } = internals(h);
      const tail = context.threadState.get("thread-1")!.refusedCellTail!.tail;
      const reader = tail as unknown as { readAppended: () => Promise<void> };
      const read = reader.readAppended.bind(reader);
      reader.readAppended = async () => {
        await gate.promise;
        await read();
      };
      reasoning(h, "r2", 4_000);
      h.child().notify("item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "large-answer",
        delta: "x".repeat(300_000),
      });
      finish(h, 5_000);
      await h.engine.getSupervisor().notificationQueue.drainAll();
      expect(
        h.events.some(
          (event) =>
            event.type === "session.reconcile-required" &&
            (event.data as { reason?: string }).reason === "rollout-event-queue-overflow",
        ),
      ).toBe(true);
      gate.resolve();
      await h.drain();
      expect(
        (await assistantRows(h, sessionId))
          .flatMap((row) => row.parts)
          .some(
            (part) => part.type === "text" && part.content === "create, edit and shell were denied",
          ),
      ).toBe(true);
      expect(h.runtime.getStatus(sessionId)).toMatchObject({ status: "idle" });
    } finally {
      gate.resolve();
      await cleanup();
    }
  });
});
