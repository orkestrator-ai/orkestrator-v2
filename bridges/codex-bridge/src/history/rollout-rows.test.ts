import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearTranscriptCache } from "../transcript-cache.js";
import {
  hydrateMessagesFromPersistedSession,
  invalidateTranscriptCatalogCache,
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
