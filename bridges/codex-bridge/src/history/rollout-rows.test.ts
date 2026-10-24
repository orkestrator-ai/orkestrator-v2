import { TurnAccumulator } from "../sessions/turn-accumulator.js";
import { reduceNotification } from "../app-server/event-reducer.js";
import type { EngineEvent } from "../engine/types.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearTranscriptCache } from "../transcript-cache.js";
import {
  hydrateMessagesFromPersistedSession,
  invalidateTranscriptCatalogCache,
  replayedRowId,
} from "./rollout.js";

let root: string;
let previousCodexHome: string | undefined;
let previousCwd: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "codex-rollout-rows-"));
  await mkdir(join(root, "sessions"), { recursive: true });
  previousCodexHome = process.env.CODEX_HOME;
  previousCwd = process.env.CWD;
  process.env.CODEX_HOME = root;
  process.env.CWD = "/fixture";
});

afterEach(async () => {
  clearTranscriptCache();
  invalidateTranscriptCatalogCache();
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousCwd === undefined) delete process.env.CWD;
  else process.env.CWD = previousCwd;
  await rm(root, { recursive: true, force: true });
});

const at = (second: number) => new Date(Date.UTC(2026, 9, 14, 10, 0, second)).toISOString();
const jsonl = (records: object[]) =>
  records.map((record) => `${JSON.stringify(record)}\n`).join("");
const response = (second: number, payload: Record<string, unknown>) => ({
  timestamp: at(second),
  type: "response_item",
  payload,
});
const reasoning = (second: number) =>
  response(second, { type: "reasoning", summary: [], encrypted_content: "opaque" });
const message = (second: number, role: "user" | "assistant", text: string) =>
  response(second, {
    type: "message",
    role,
    content: [{ type: role === "user" ? "input_text" : "output_text", text }],
  });

async function writeRollouts(records: object[]): Promise<void> {
  await writeFile(join(root, "sessions", "steps.jsonl"), jsonl(records));
  await writeFile(
    join(root, "sessions", "child-1.jsonl"),
    jsonl([
      {
        timestamp: at(5),
        type: "session_meta",
        payload: {
          id: "child-1",
          cwd: "/fixture",
          agent_nickname: "Ada",
          source: { subagent: { thread_spawn: { parent_thread_id: "steps" } } },
        },
      },
      { timestamp: at(6), type: "event_msg", payload: { type: "task_started" } },
      {
        timestamp: at(7),
        type: "event_msg",
        payload: { type: "agent_message", phase: "final_answer", message: "Reviewed" },
      },
    ]),
  );
  await writeFile(
    join(root, "session_index.jsonl"),
    `${JSON.stringify({ id: "steps", updated_at: at(59) })}\n`,
  );
}

describe("rollout rows", () => {
  test("a turn reloads as one row per model response, as it streamed", async () => {
    await writeRollouts([
      { timestamp: at(0), type: "session_meta", payload: { id: "steps", cwd: "/fixture" } },
      { timestamp: at(0), type: "turn_context", payload: { turn_id: "turn-1" } },
      message(1, "user", "Review and test it"),
      // Response 1: commentary, then a spawn.
      reasoning(2),
      message(3, "assistant", "Spawning a reviewer."),
      response(4, {
        type: "function_call",
        name: "spawn_agent",
        call_id: "spawn-1",
        arguments: JSON.stringify({ task_name: "review", message: "Review it" }),
      }),
      response(5, {
        type: "function_call_output",
        call_id: "spawn-1",
        output: JSON.stringify({ agent_id: "child-1", nickname: "Ada" }),
      }),
      // Response 2: two parallel calls stay together.
      reasoning(6),
      response(7, {
        type: "function_call",
        name: "exec_command",
        call_id: "exec-1",
        arguments: JSON.stringify({ cmd: "bun test" }),
      }),
      response(7, {
        type: "function_call",
        name: "exec_command",
        call_id: "exec-2",
        arguments: JSON.stringify({ cmd: "bun run lint" }),
      }),
      response(8, { type: "function_call_output", call_id: "exec-1", output: "ok" }),
      response(8, { type: "function_call_output", call_id: "exec-2", output: "ok" }),
      // Response 3: the answer.
      reasoning(9),
      message(10, "assistant", "Reviewed and tested."),
      // A turn that called no tool stays one row.
      { timestamp: at(20), type: "turn_context", payload: { turn_id: "turn-2" } },
      message(21, "user", "Thanks"),
      reasoning(22),
      message(23, "assistant", "Anytime."),
    ]);

    const hydrated = await hydrateMessagesFromPersistedSession("steps");
    const rows = hydrated.messages;
    expect(rows.map((row) => [row.role, row.turnId, row.content])).toEqual([
      ["user", "turn-1", "Review and test it"],
      ["assistant", "turn-1", "Spawning a reviewer."],
      ["assistant", "turn-1", ""],
      ["assistant", "turn-1", "Reviewed and tested."],
      ["user", "turn-2", "Thanks"],
      ["assistant", "turn-2", "Anytime."],
    ]);
    // A row a response opens starts where that response did.
    expect(rows.slice(2, 4).map((row) => row.createdAt)).toEqual([at(6), at(9)]);
    // The child's card replaces the spawn call on the row that made it.
    expect(rows[1]?.parts).toEqual([
      { type: "text", content: "Spawning a reviewer." },
      expect.objectContaining({ type: "subagent", subagentId: "child-1", subagentName: "Ada" }),
    ]);
    expect(rows[2]?.parts.map((part) => part.toolUseId)).toEqual(["exec-1", "exec-2"]);
    expect(rows[3]?.parts).toEqual([{ type: "text", content: "Reviewed and tested." }]);
  });
});

test("live exec_command, repeated write_stdin, and request_user_input boundaries match rollout replay", async () => {
  const records: object[] = [
    { timestamp: at(0), type: "session_meta", payload: { id: "steps", cwd: "/fixture" } },
    { timestamp: at(0), type: "turn_context", payload: { turn_id: "turn-1" } },
    message(0, "user", "Run it"),
  ];
  const turn = new TurnAccumulator({
    threadId: "steps",
    turnId: "turn-1",
    engineGeneration: 1,
    assistantMessageId: "live-0",
  });
  const boundaries: string[] = [];
  for (let step = 0; step < 5; step++) {
    const text = `response ${step}`;
    records.push(reasoning(step * 3 + 1), message(step * 3 + 1, "assistant", text));
    const event: EngineEvent = {
      kind: "item.text.delta",
      threadId: "steps",
      turnId: "turn-1",
      itemId: `a${step}`,
      delta: text,
    };
    if (turn.opensModelStep(event)) turn.startModelStep(`live-${step}`, at(step * 3 + 1));
    turn.onTextDelta(event.itemId, event.delta);
    boundaries.push(turn.assistantMessageId);
    if (step === 4) break;
    const name = step === 0 ? "exec_command" : step === 3 ? "request_user_input" : "write_stdin";
    records.push(
      response(step * 3 + 2, {
        type: "function_call",
        call_id: `call-${step}`,
        name,
        arguments: "{}",
      }),
      response(step * 3 + 3, {
        type: "function_call_output",
        call_id: `call-${step}`,
        output: "waiting",
      }),
    );
    // Polls have terminalInteraction but no new commandExecution item.
    const result = reduceNotification(
      {
        kind: "notification",
        method:
          step === 1 || step === 2
            ? "item/commandExecution/terminalInteraction"
            : "rawResponseItem/completed",
        params: {
          threadId: "steps",
          turnId: "turn-1",
          item: { type: "function_call", call_id: `call-${step}`, name, arguments: "{}" },
        },
      },
      1,
      "handle",
    );
    for (const reduced of result.events)
      if (reduced.kind === "model.tool.called") turn.noteModelToolCall();
  }
  await writeRollouts(records);
  const hydrated = await hydrateMessagesFromPersistedSession("steps");
  const replayRows = hydrated.messages.filter((row) => row.role === "assistant");
  expect(new Set(boundaries).size).toBe(replayRows.length);
  expect(replayRows.map((row) => row.content)).toEqual(
    Array.from({ length: 5 }, (_, i) => `response ${i}`),
  );
});

describe("tool-only responses", () => {
  const usage = (second: number, turnId = "turn-1") => ({
    timestamp: at(second),
    type: "token_usage_record",
    payload: { turn_id: turnId },
  });
  const call = (second: number, callId: string) =>
    response(second, {
      type: "function_call",
      name: "exec_command",
      call_id: callId,
      arguments: JSON.stringify({ cmd: `cat ${callId}` }),
    });
  const output = (second: number, callId: string) =>
    response(second, { type: "function_call_output", call_id: callId, output: "next" });
  const commandItem = (id: string): Parameters<TurnAccumulator["onItemStarted"]>[0] => ({
    id,
    type: "command_execution",
    command: `cat ${id}`,
    aggregated_output: "",
    status: "in_progress",
  });

  /** Responses of the turn: each is the calls it made, run one after another. */
  const responses = [["read-1"], ["read-2"], ["read-3", "read-4"], ["read-5"]];

  test("split at each usage report, live and on reload alike", async () => {
    const records: object[] = [
      { timestamp: at(0), type: "session_meta", payload: { id: "steps", cwd: "/fixture" } },
      { timestamp: at(0), type: "turn_context", payload: { turn_id: "turn-1" } },
      message(0, "user", "Follow the trail"),
    ];
    const turn = new TurnAccumulator({
      threadId: "steps",
      turnId: "turn-1",
      engineGeneration: 1,
      assistantMessageId: "live-0",
    });
    let second = 1;
    for (const [index, calls] of responses.entries()) {
      for (const callId of calls) {
        records.push(call(second, callId));
        const started = {
          kind: "item.started",
          threadId: "steps",
          turnId: "turn-1",
          item: commandItem(callId),
        } as const;
        if (turn.opensModelStep(started)) turn.startModelStep(`live-${index}`, at(second));
        turn.onItemStarted(started.item);
      }
      // The usage report lands before the calls' outputs, as codex records it.
      records.push(usage(second));
      const reduced = reduceNotification(
        {
          kind: "notification",
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "steps",
            turnId: "turn-1",
            tokenUsage: { total: {}, last: { totalTokens: 22 }, modelContextWindow: 1000 },
          },
        },
        1,
        "handle",
      );
      for (const event of reduced.events) {
        if (event.kind === "model.response.completed") turn.noteModelResponseCompleted();
      }
      for (const callId of calls) records.push(output(second, callId));
      records.push({ timestamp: at(second), type: "event_msg", payload: { type: "token_count" } });
      second += 1;
    }
    await writeRollouts(records);

    const live = turn
      .assistantSegmentsInOrder()
      .map((segment) =>
        turn.orderedForAssistantSegment(segment.assistantMessageId).map((item) => item.id),
      );
    const hydrated = await hydrateMessagesFromPersistedSession("steps");
    const reloaded = hydrated.messages
      .filter((row) => row.role === "assistant")
      .map((row) => row.parts.map((part) => part.toolUseId));
    expect(live).toEqual(responses);
    expect(reloaded).toEqual(responses);
  });

  test("legacy token_count alone splits tool-only responses and preserves late outputs", async () => {
    const legacyUsage = (second: number) => ({
      timestamp: at(second),
      type: "event_msg",
      payload: { type: "token_count" },
    });
    await writeRollouts([
      { timestamp: at(0), type: "session_meta", payload: { id: "steps", cwd: "/fixture" } },
      { timestamp: at(0), type: "turn_context", payload: { turn_id: "turn-1" } },
      message(0, "user", "Follow the trail"),
      call(1, "read-1"),
      call(1, "read-2"),
      legacyUsage(1),
      call(2, "read-3"),
      legacyUsage(2),
      output(3, "read-1"),
      output(3, "read-2"),
      output(3, "read-3"),
      call(4, "read-4"),
      legacyUsage(4),
      output(4, "read-4"),
    ]);
    const hydrated = await hydrateMessagesFromPersistedSession("steps");
    const rows = hydrated.messages.filter((row) => row.role === "assistant");
    expect(rows.map((row) => row.parts.map((part) => part.toolUseId))).toEqual([
      ["read-1", "read-2"],
      ["read-3"],
      ["read-4"],
    ]);
    expect(rows.flatMap((row) => row.parts).map((part) => part.toolOutput)).toEqual([
      "next",
      "next",
      "next",
      "next",
    ]);
  });

  test("without usage reports a tool-only run stays one row, as before", async () => {
    await writeRollouts([
      { timestamp: at(0), type: "session_meta", payload: { id: "steps", cwd: "/fixture" } },
      { timestamp: at(0), type: "turn_context", payload: { turn_id: "turn-1" } },
      message(0, "user", "Follow the trail"),
      call(1, "read-1"),
      output(1, "read-1"),
      call(2, "read-2"),
      output(2, "read-2"),
    ]);
    const hydrated = await hydrateMessagesFromPersistedSession("steps");
    expect(
      hydrated.messages
        .filter((row) => row.role === "assistant")
        .map((row) => row.parts.map((part) => part.toolUseId)),
    ).toEqual([["read-1", "read-2"]]);
  });
});

describe("replayed row ids", () => {
  const records = (turns: number): object[] => {
    const out: object[] = [
      { timestamp: at(0), type: "session_meta", payload: { id: "steps", cwd: "/fixture" } },
    ];
    for (let turn = 1; turn <= turns; turn += 1) {
      out.push(
        { timestamp: at(turn * 5), type: "turn_context", payload: { turn_id: `turn-${turn}` } },
        message(turn * 5, "user", `Prompt ${turn}`),
        response(turn * 5 + 1, {
          type: "function_call",
          name: "exec_command",
          call_id: `call-${turn}`,
          arguments: "{}",
        }),
        {
          timestamp: at(turn * 5 + 1),
          type: "token_usage_record",
          payload: { turn_id: `turn-${turn}` },
        },
        response(turn * 5 + 2, {
          type: "function_call_output",
          call_id: `call-${turn}`,
          output: "ok",
        }),
        reasoning(turn * 5 + 3),
        message(turn * 5 + 3, "assistant", `Answer ${turn}`),
      );
    }
    return out;
  };

  test("every replay of a rollout names its rows alike, and the rows stay unique", async () => {
    await writeRollouts(records(2));
    const first = (await hydrateMessagesFromPersistedSession("steps")).messages.map(
      (row) => row.id,
    );
    clearTranscriptCache();
    invalidateTranscriptCatalogCache();
    const second = (await hydrateMessagesFromPersistedSession("steps")).messages.map(
      (row) => row.id,
    );
    expect(first).toHaveLength(6);
    expect(new Set(first).size).toBe(first.length);
    expect(second).toEqual(first);

    // A rollout only grows: a later turn leaves the earlier rows' ids alone.
    await writeRollouts(records(3));
    clearTranscriptCache();
    invalidateTranscriptCatalogCache();
    const grown = (await hydrateMessagesFromPersistedSession("steps")).messages.map(
      (row) => row.id,
    );
    expect(grown.slice(0, first.length)).toEqual(first);
    expect(new Set(grown).size).toBe(grown.length);
  });

  test("ids are scoped to the thread", () => {
    expect(replayedRowId("thread-a", "turn-1", "assistant", 0)).not.toBe(
      replayedRowId("thread-b", "turn-1", "assistant", 0),
    );
    expect(replayedRowId("thread-a", "turn-1", "assistant", 0)).not.toBe(
      replayedRowId("thread-a", "turn-1", "user", 0),
    );
    expect(replayedRowId("thread-a", "turn-1", "assistant", 0)).toMatch(/^msg-r-[0-9a-f]{32}$/);
  });
});
