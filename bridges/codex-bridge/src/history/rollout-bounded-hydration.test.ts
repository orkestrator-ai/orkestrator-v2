import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedMessage } from "../messages/types.js";
import {
  clearTranscriptCache,
  getTranscriptCacheStats,
  setTranscriptCacheLimitsForTesting,
} from "../transcript-cache.js";
import {
  hydrateMessagesFromPersistedSession,
  invalidateTranscriptCatalogCache,
} from "./rollout.js";

let root: string;
let previousCodexHome: string | undefined;
let previousCwd: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "codex-bounded-hydration-"));
  await mkdir(join(root, "sessions"), { recursive: true });
  previousCodexHome = process.env.CODEX_HOME;
  previousCwd = process.env.CWD;
  process.env.CODEX_HOME = root;
  process.env.CWD = "/fixture";
});

afterEach(async () => {
  clearTranscriptCache();
  setTranscriptCacheLimitsForTesting();
  invalidateTranscriptCatalogCache();
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousCwd === undefined) delete process.env.CWD;
  else process.env.CWD = previousCwd;
  await rm(root, { recursive: true, force: true });
});

const at = (second: number) => new Date(Date.UTC(2026, 8, 1, 12, 0, second)).toISOString();
const jsonl = (records: object[]) =>
  records.map((record) => `${JSON.stringify(record)}\n`).join("");
const response = (second: number, payload: Record<string, unknown>) => ({
  timestamp: at(second),
  type: "response_item",
  payload,
});
const userMessage = (second: number, text: string) =>
  response(second, { type: "message", role: "user", content: [{ type: "input_text", text }] });
const assistantMessage = (second: number, text: string, phase?: string) =>
  response(second, {
    type: "message",
    role: "assistant",
    ...(phase ? { phase } : {}),
    content: [{ type: "output_text", text }],
  });

/** A parent rollout with tool calls, a sub-agent, and a structured-output turn. */
function parentRollout(extraTurns: number): object[] {
  const records: object[] = [
    { timestamp: at(0), type: "session_meta", payload: { id: "parent", cwd: "/fixture" } },
  ];
  for (let turn = 0; turn < extraTurns; turn += 1) {
    const base = 10 + turn * 10;
    records.push(
      { timestamp: at(base), type: "turn_context", payload: { turn_id: `turn-${turn}` } },
      userMessage(base + 1, `question ${turn}`),
      response(base + 2, {
        type: "function_call",
        name: "exec_command",
        call_id: `exec-${turn}`,
        arguments: JSON.stringify({ cmd: `echo ${turn}` }),
      }),
      response(base + 3, {
        type: "function_call_output",
        call_id: `exec-${turn}`,
        output: `output ${turn} ${"o".repeat(300)}`,
      }),
      assistantMessage(base + 4, `answer ${turn}`),
    );
  }
  const last = 10 + extraTurns * 10;
  records.push(
    { timestamp: at(last), type: "turn_context", payload: { turn_id: "structured" } },
    userMessage(last + 1, "spawn a reviewer and answer in JSON"),
    response(last + 2, {
      type: "function_call",
      name: "spawn_agent",
      call_id: "spawn-1",
      arguments: JSON.stringify({ task_name: "review", message: "Review it" }),
    }),
    response(last + 3, {
      type: "function_call_output",
      call_id: "spawn-1",
      output: JSON.stringify({ agent_id: "child-1", nickname: "Ada" }),
    }),
    assistantMessage(last + 4, '{"draft":true}'),
    assistantMessage(last + 5, '{"result":42}', "final_answer"),
  );
  return records;
}

async function writeRollouts(extraTurns: number, extraParentLines = ""): Promise<void> {
  await writeFile(
    join(root, "sessions", "parent.jsonl"),
    jsonl(parentRollout(extraTurns)) + extraParentLines,
  );
  await writeFile(
    join(root, "sessions", "child-1.jsonl"),
    jsonl([
      {
        timestamp: at(1),
        type: "session_meta",
        payload: {
          id: "child-1",
          cwd: "/fixture",
          agent_nickname: "Ada",
          source: { subagent: { thread_spawn: { parent_thread_id: "parent" } } },
        },
      },
      { timestamp: at(2), type: "event_msg", payload: { type: "task_started" } },
      {
        timestamp: at(3),
        type: "event_msg",
        payload: { type: "agent_message", phase: "final_answer", message: "Reviewed" },
      },
    ]),
  );
  await writeFile(
    join(root, "session_index.jsonl"),
    `${JSON.stringify({ id: "parent", updated_at: at(999) })}\n`,
  );
}

/** Message ids are random; everything else must match exactly. */
function comparable(messages: NormalizedMessage[]) {
  return messages.map(({ id: _id, ...message }) => message);
}

async function hydrate() {
  return hydrateMessagesFromPersistedSession("parent", {
    structuredOutputTurns: [{ turnId: "structured", accepted: true }],
  });
}

describe("bounded rollout hydration", () => {
  test("a rollout far above the cache budget hydrates identically to an unbounded read", async () => {
    await writeRollouts(40);
    const unbounded = await hydrate();
    expect(unbounded.transcriptStatus).toBe("complete");
    const parts = unbounded.messages.flatMap((message) => message.parts);
    expect(parts.find((part) => part.type === "subagent")).toMatchObject({
      subagentId: "child-1",
      subagentName: "Ada",
      toolState: "success",
    });
    // The withheld draft is dropped; only the accepted final JSON remains.
    expect(unbounded.messages.at(-1)?.content).toBe('{"result":42}');

    clearTranscriptCache();
    const hardBudgetBytes = 8 * 1024;
    setTranscriptCacheLimitsForTesting({
      softBudgetBytes: 0,
      hardBudgetBytes,
      blockSourceBytes: 1024,
      chunkBytes: 512,
    });
    const bounded = await hydrate();

    expect(comparable(bounded.messages)).toEqual(comparable(unbounded.messages));
    expect(bounded.transcriptStatus).toBe("complete");
    expect(getTranscriptCacheStats().bytes).toBeLessThanOrEqual(hardBudgetBytes);
    // The whole rollout was scanned once; the replay passes re-read shed
    // blocks transiently instead of rescanning or retaining the file.
    expect(getTranscriptCacheStats().coldScans).toBe(2);
    expect(getTranscriptCacheStats().blockRereads).toBeGreaterThan(0);
  });

  test("an overlong record is shown where it was, and the result is degraded", async () => {
    setTranscriptCacheLimitsForTesting({ maxRecordBytes: 2048 });
    await writeRollouts(
      1,
      jsonl([userMessage(900, "x".repeat(4096)), assistantMessage(901, "after the gap")]),
    );

    const hydrated = await hydrate();

    expect(hydrated.transcriptStatus).toBe("degraded");
    const gapIndex = hydrated.messages.findIndex((message) =>
      message.parts.some((part) => part.type === "status"),
    );
    expect(hydrated.messages[gapIndex]?.parts).toEqual([
      {
        type: "status",
        severity: "warning",
        content: expect.stringMatching(
          /^A rollout record could not be restored \(larger than the record size limit; rollout bytes \d+–\d+\)\.$/,
        ),
      },
    ]);
    expect(hydrated.messages[gapIndex + 1]).toMatchObject({
      role: "assistant",
      content: "after the gap",
    });
  });

  test("a thread whose rollout cannot be read is unavailable, not empty", async () => {
    const hydrated = await hydrateMessagesFromPersistedSession("missing-thread");
    expect(hydrated).toMatchObject({ messages: [], transcriptStatus: "unavailable" });
  });
});
