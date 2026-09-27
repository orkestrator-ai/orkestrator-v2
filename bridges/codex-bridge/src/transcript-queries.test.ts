import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveTranscriptSubagentPartsForTurn } from "./subagent-transcript-parts.js";
import {
  INCOMPLETE_CHILD_TRANSCRIPT_NOTICE,
  parseTranscriptRecords,
  summarizeChildTranscriptRecords,
} from "./subagent-transcript.js";
import {
  clearTranscriptCache,
  getTranscriptCacheStats,
  setTranscriptCacheLimitsForTesting,
} from "./transcript-cache.js";
import {
  cachedTranscriptQueries,
  readCachedChildTranscriptSummary,
  transcriptQueriesFromLoader,
} from "./transcript-queries.js";

let root: string | undefined;

afterEach(async () => {
  clearTranscriptCache();
  setTranscriptCacheLimitsForTesting();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

const at = (second: number) => new Date(Date.UTC(2026, 8, 1, 12, 0, second)).toISOString();
const jsonl = (records: object[]) =>
  records.map((record) => `${JSON.stringify(record)}\n`).join("");

function parentRecords(): object[] {
  const filler = Array.from({ length: 60 }, (_, index) => ({
    timestamp: at(index),
    type: "event_msg",
    payload: { type: "token_count", padding: "p".repeat(200) },
  }));
  return [
    { timestamp: at(0), type: "session_meta", payload: { id: "parent", source: "vscode" } },
    ...filler,
    { timestamp: at(100), type: "turn_context", payload: { turn_id: "turn-2" } },
    {
      timestamp: at(101),
      type: "response_item",
      payload: {
        type: "function_call",
        name: "spawn_agent",
        call_id: "spawn-1",
        arguments: JSON.stringify({ task_name: "review", message: "Review the change" }),
      },
    },
    {
      timestamp: at(102),
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "spawn-1",
        output: JSON.stringify({ agent_id: "child-1", nickname: "Ada" }),
      },
    },
  ];
}

function childRecords(): object[] {
  return [
    {
      timestamp: at(101),
      type: "session_meta",
      payload: { id: "child-1", agent_nickname: "Ada", agent_role: "reviewer" },
    },
    { timestamp: at(102), type: "turn_context", payload: { turn_id: "child-turn-1" } },
    {
      timestamp: at(103),
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "exec-1",
        arguments: JSON.stringify({ cmd: "git diff" }),
      },
    },
    {
      timestamp: at(104),
      type: "response_item",
      payload: { type: "function_call_output", call_id: "exec-1", output: "diff --git a b" },
    },
    {
      timestamp: at(105),
      type: "event_msg",
      payload: { type: "agent_message", phase: "commentary", message: "Looking at the diff" },
    },
  ];
}

async function fixture() {
  root = await mkdtemp(join(tmpdir(), "codex-transcript-queries-"));
  const parent = join(root, "parent.jsonl");
  const child = join(root, "child.jsonl");
  await writeFile(parent, jsonl(parentRecords()));
  await writeFile(child, jsonl(childRecords()));
  return { parent, child };
}

const readWholeFile = async (path: string) => ({
  records: parseTranscriptRecords((await readFile(path, "utf8")).split("\n").filter(Boolean)),
});

function derive(
  paths: { parent: string; child: string },
  source: "cache" | "memory",
): ReturnType<typeof deriveTranscriptSubagentPartsForTurn> {
  const common = {
    threadId: "parent",
    currentTurnStartedAt: at(100),
    loadSessionMeta: async (id: string) =>
      id === "parent"
        ? { transcriptPath: paths.parent }
        : id === "child-1"
          ? { transcriptPath: paths.child }
          : null,
  };
  return source === "cache"
    ? deriveTranscriptSubagentPartsForTurn({
        ...common,
        transcriptQueries: cachedTranscriptQueries,
      })
    : deriveTranscriptSubagentPartsForTurn({ ...common, loadTranscript: readWholeFile });
}

describe("bounded transcript queries", () => {
  test.each([
    ["default budgets", {}],
    [
      "budgets far below the rollouts",
      { softBudgetBytes: 0, hardBudgetBytes: 4 * 1024, blockSourceBytes: 512, chunkBytes: 256 },
    ],
  ])("sub-agent cards match a whole-file parse (%s)", async (_label, limits) => {
    setTranscriptCacheLimitsForTesting(limits);
    const paths = await fixture();

    const expected = await derive(paths, "memory");
    expect(expected).toHaveLength(1);
    expect(expected[0]).toMatchObject({ subagentName: "Ada", toolState: "pending" });
    expect(await derive(paths, "cache")).toEqual(expected);

    // A follow-up turn on the reusable child, appended while rendering.
    await appendFile(
      paths.child,
      jsonl([
        { timestamp: at(106), type: "event_msg", payload: { type: "task_complete" } },
        { timestamp: at(107), type: "event_msg", payload: { type: "user_message" } },
        {
          timestamp: at(108),
          type: "event_msg",
          payload: { type: "agent_message", phase: "final_answer", message: "Looks good" },
        },
      ]),
    );
    const afterAppend = await derive(paths, "memory");
    expect(afterAppend[0]).toMatchObject({ toolState: "success" });
    expect(await derive(paths, "cache")).toEqual(afterAppend);
  });

  test("repeated renders read neither rollout again while unchanged", async () => {
    const paths = await fixture();
    const first = await derive(paths, "cache");
    const afterFirst = getTranscriptCacheStats();
    expect(afterFirst.coldScans).toBe(2);

    for (let index = 0; index < 10; index += 1) {
      expect(await derive(paths, "cache")).toEqual(first);
    }
    expect(getTranscriptCacheStats()).toMatchObject({
      coldScans: 2,
      appendScans: 0,
      sourceBytesRead: afterFirst.sourceBytesRead,
      blockRereads: afterFirst.blockRereads,
    });
  });

  test("the parent turn query skips blocks older than the turn", async () => {
    setTranscriptCacheLimitsForTesting({
      softBudgetBytes: 0,
      hardBudgetBytes: 0,
      blockSourceBytes: 512,
    });
    const paths = await fixture();
    // Nothing stays resident, so every block the query touches is re-read.
    const result = await cachedTranscriptQueries.readTurnRecords(paths.parent, Date.parse(at(100)));
    expect(result.records.map((record) => record.type)).toEqual([
      "turn_context",
      "response_item",
      "response_item",
    ]);
    expect(result.sessionMeta?.payload?.id).toBe("parent");
    const stats = getTranscriptCacheStats();
    // Only the final block(s) holding this turn were re-read, not the ~60
    // filler records before it.
    expect(stats.blockRereads).toBeLessThanOrEqual(2);
  });

  test("an unreadable child record degrades its card visibly", async () => {
    setTranscriptCacheLimitsForTesting({ maxRecordBytes: 256 });
    const paths = await fixture();
    await appendFile(
      paths.child,
      jsonl([
        {
          timestamp: at(106),
          type: "response_item",
          payload: { type: "function_call_output", call_id: "x", output: "o".repeat(1000) },
        },
      ]),
    );

    const summary = await readCachedChildTranscriptSummary(paths.child);
    expect(summary.readStatus).toBe("degraded");
    const [part] = await derive(paths, "cache");
    expect(part?.subagentActions.at(-1)).toEqual({
      type: "text",
      content: INCOMPLETE_CHILD_TRANSCRIPT_NOTICE,
    });
  });

  test("a child rollout that cannot be read is unavailable, not an idle child", async () => {
    const paths = await fixture();
    await rm(paths.child);

    expect((await readCachedChildTranscriptSummary(paths.child)).readStatus).toBe("unavailable");
    const [part] = await derive(paths, "cache");
    expect(part?.subagentActions).toEqual([
      { type: "text", content: INCOMPLETE_CHILD_TRANSCRIPT_NOTICE },
    ]);
  });

  test("the in-memory adapter answers the same shapes from whole records", async () => {
    const paths = await fixture();
    const memory = transcriptQueriesFromLoader(readWholeFile);
    const since = Date.parse(at(100));
    const [cached, inMemory] = await Promise.all([
      cachedTranscriptQueries.readTurnRecords(paths.parent, since),
      memory.readTurnRecords(paths.parent, since),
    ]);
    expect(cached).toEqual(inMemory);
    expect(await cachedTranscriptQueries.readChildSummary(paths.child)).toEqual(
      summarizeChildTranscriptRecords((await readWholeFile(paths.child)).records),
    );
  });
});
