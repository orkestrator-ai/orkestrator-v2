import { describe, expect, test } from "bun:test";
import { loadSubagentPartsFromTranscripts } from "./render-turn.js";
import { deriveTranscriptSubagentPartsForTurn } from "../subagent-transcript-parts.js";
import type { TranscriptRecord } from "../subagent-transcript.js";
import type { EngineItem } from "../engine/types.js";

const startedAt = "2026-09-07T09:57:00.000Z";
const record = (payload: Record<string, unknown>): TranscriptRecord => ({
  timestamp: startedAt,
  type: "response_item",
  payload,
});
function spawn(name: string, output: string): TranscriptRecord[] {
  return [
    record({
      type: "function_call",
      name: "spawn_agent",
      call_id: `call-${name}`,
      arguments: JSON.stringify({ task_name: name }),
    }),
    record({ type: "function_call_output", call_id: `call-${name}`, output }),
  ];
}
const activity = (name: string): EngineItem => ({
  id: `unrelated-event-${name}`,
  type: "subagent_activity",
  activity: "started",
  agent_thread_id: `child-${name}`,
  agent_path: `/root/${name}`,
});

async function load(records: TranscriptRecord[], items: EngineItem[]) {
  const loaded: string[] = [];
  const parts = await loadSubagentPartsFromTranscripts(
    { threadId: "parent", turnStartedAt: startedAt, items },
    {
      createTranscriptMetaLoader: () => async (id) => ({
        id,
        updatedAt: startedAt,
        transcriptPath: id,
      }),
      deriveTranscriptParts: deriveTranscriptSubagentPartsForTurn,
      resolveChildPaths: async () => new Map(),
      readTranscript: async (path) => {
        loaded.push(path);
        return {
          records:
            path === "parent"
              ? records
              : [
                  { type: "session_meta", payload: { id: path, agent_nickname: "Fixture child" } },
                  record({
                    type: "message",
                    role: "assistant",
                    phase: "final_answer",
                    content: [{ type: "output_text", text: "Fixture done" }],
                  }),
                ],
        };
      },
    },
  );
  return { parts, loaded };
}

describe("activity-only spawn identity reconciliation", () => {
  test("hydrates each of four path-only spawns once and preserves a failed fifth attempt", async () => {
    const names = ["one", "two", "three", "four"];
    const records = names.flatMap((name) =>
      spawn(name, JSON.stringify({ task_name: `/root/${name}` })),
    );
    records.splice(4, 0, ...spawn("rejected", "collab spawn failed: agent thread limit reached"));
    const { parts, loaded } = await load(records, names.toReversed().map(activity));
    expect(parts).toHaveLength(5);
    expect(
      parts
        .filter((part) => part.subagentId)
        .map((part) => part.subagentId)
        .sort(),
    ).toEqual(names.map((name) => `child-${name}`).sort());
    expect(loaded.sort()).toEqual(["parent", ...names.map((name) => `child-${name}`)].sort());
    expect(
      parts.filter((part) => part.subagentId).every((part) => part.toolState === "success"),
    ).toBe(true);
    expect(parts.find((part) => part.subagentRole === "rejected")).toMatchObject({
      toolState: "failure",
      subagentActionCount: 0,
      subagentActions: [{ type: "text", content: "Agent could not start: agent limit reached." }],
    });
  });

  test("unknown spawn outputs do not invent a terminal outcome", async () => {
    for (const output of ["", "{", "unrelated output", "null"]) {
      const { parts } = await load(spawn("unknown", output), []);
      expect(parts).toHaveLength(1);
      expect(parts[0]?.toolState).toBe("pending");
      expect(parts[0]?.subagentId).toBeUndefined();
    }
  });

  test("keeps receiver-less rejected launches when a row owns a successful child", async () => {
    const records = [
      ...spawn("accepted", JSON.stringify({ task_name: "/root/accepted" })),
      ...spawn("rejected", "collab spawn failed: agent thread limit reached"),
    ];
    const { parts } = await load(records, [
      {
        id: "native-spawn",
        type: "collab_tool_call",
        tool: "spawn_agent",
        receiver_thread_ids: ["child-accepted"],
        status: "completed",
      },
    ]);
    expect(parts).toHaveLength(2);
    expect(parts.map((part) => [part.subagentRole, part.subagentId, part.toolState])).toEqual([
      ["accepted", "child-accepted", "success"],
      ["rejected", undefined, "failure"],
    ]);
  });

  test("hydrates path-only spawns from persisted child identity after restart", async () => {
    const records = spawn("review", JSON.stringify({ task_name: "/root/review" }));
    const loaded: string[] = [];
    const parts = await loadSubagentPartsFromTranscripts(
      { threadId: "parent", turnStartedAt: startedAt, items: [] },
      {
        createTranscriptMetaLoader: () => async (id) => ({ transcriptPath: id }),
        deriveTranscriptParts: deriveTranscriptSubagentPartsForTurn,
        resolveChildPaths: async (parent, paths) => {
          expect(parent).toBe("parent");
          expect(paths).toEqual(["/root/review"]);
          return new Map([["/root/review", "persisted-child"]]);
        },
        readTranscript: async (path) => {
          loaded.push(path);
          return { records: path === "parent" ? records : [] };
        },
      },
    );
    expect(parts).toHaveLength(1);
    expect(parts[0]?.subagentId).toBe("persisted-child");
    expect(loaded).toEqual(["parent", "persisted-child"]);
  });

  test("keeps running children pending while excluding a rejected fifth launch", async () => {
    const names = ["one", "two", "three", "four"];
    const records = names.flatMap((name) =>
      spawn(name, JSON.stringify({ task_name: `/root/${name}` })),
    );
    records.push(...spawn("rejected", "collab spawn failed: agent thread limit reached"));
    const parts = await loadSubagentPartsFromTranscripts(
      { threadId: "parent", turnStartedAt: startedAt, items: names.map(activity) },
      {
        createTranscriptMetaLoader: () => async (id) => ({ transcriptPath: id }),
        deriveTranscriptParts: deriveTranscriptSubagentPartsForTurn,
        resolveChildPaths: async () => new Map(),
        readTranscript: async (path) => ({
          records:
            path === "parent"
              ? records
              : [{ type: "session_meta", payload: { id: path, agent_nickname: path } }],
        }),
      },
    );

    expect(parts.filter((part) => part.toolState === "pending")).toHaveLength(4);
    expect(parts.filter((part) => part.toolState === "failure")).toHaveLength(1);
    expect(parts.filter((part) => part.subagentId)).toHaveLength(4);
  });

  test("distinguishes nested children with the same short task name by full path", async () => {
    const records = [
      ...spawn("first", '{"task_name":"/root/first/review"}'),
      ...spawn("second", '{"task_name":"/root/second/review"}'),
    ];
    const items: EngineItem[] = [
      {
        id: "first-activity",
        type: "subagent_activity",
        activity: "started",
        agent_thread_id: "first-child",
        agent_path: "/root/first/review",
      },
      {
        id: "second-activity",
        type: "subagent_activity",
        activity: "started",
        agent_thread_id: "second-child",
        agent_path: "/root/second/review",
      },
    ];
    const { parts } = await load(records, items);

    expect(parts.map((part) => part.subagentId)).toEqual(["first-child", "second-child"]);
  });

  test("memoizes positive and negative persisted path lookups for a turn", async () => {
    const positive = spawn("review", '{"task_name":"/root/review"}');
    const negative = spawn("missing", '{"task_name":"/root/missing"}');
    const records = [...positive, ...negative];
    const pathCache = new Map<string, string | null | undefined>();
    const terminalRetries = new Set<string>();
    let resolutions = 0;
    const dependencies = {
      createTranscriptMetaLoader: () => async (id: string) => ({ transcriptPath: id }),
      deriveTranscriptParts: deriveTranscriptSubagentPartsForTurn,
      resolveChildPaths: async () => {
        resolutions += 1;
        return new Map<string, string | null>([
          ["/root/review", "persisted-child"],
          ...(resolutions > 1 ? ([["/root/missing", "late-child"]] as const) : []),
        ]);
      },
      readTranscript: async (path: string) => ({ records: path === "parent" ? records : [] }),
    };
    const options = {
      threadId: "parent",
      turnStartedAt: startedAt,
      items: [] as EngineItem[],
      childPathResolutions: pathCache,
    };

    await loadSubagentPartsFromTranscripts(options, dependencies);
    await loadSubagentPartsFromTranscripts(options, dependencies);

    expect(resolutions).toBe(1);
    expect(pathCache.has("/root/review")).toBe(true);
    expect(pathCache.get("/root/review")).toBe("persisted-child");
    expect(pathCache.has("/root/missing")).toBe(true);
    expect(pathCache.get("/root/missing")).toBeUndefined();

    const terminalOptions = {
      ...options,
      retryMissingChildPaths: true,
      retriedMissingChildPaths: terminalRetries,
    };
    await loadSubagentPartsFromTranscripts(terminalOptions, dependencies);
    await loadSubagentPartsFromTranscripts(terminalOptions, dependencies);

    expect(resolutions).toBe(2);
    expect(pathCache.get("/root/missing")).toBe("late-child");
    expect(terminalRetries).toEqual(new Set(["/root/missing"]));
  });
});
