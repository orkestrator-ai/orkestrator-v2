import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_CONCURRENT_PERSISTED_SUBAGENT_READS,
  MAX_PERSISTED_SUBAGENT_TRANSCRIPTS,
  getSessionMetaFromTranscriptPath,
  hydratePersistedSubagentParts,
  hydrateMessagesFromPersistedSession,
  invalidateTranscriptCatalogCache,
  resolvePersistedChildThreadIds,
} from "./rollout.js";

let root: string | undefined;
let previousCodexHome: string | undefined;
let previousCwd: string | undefined;

async function writeChild(id: string, parent: string, path: string): Promise<string> {
  const file = join(root!, "sessions", `${id}.jsonl`);
  await writeFile(
    file,
    `${JSON.stringify({
      type: "session_meta",
      payload: {
        id,
        cwd: "/fixture",
        timestamp: "2026-09-07T09:57:00.000Z",
        source: {
          subagent: {
            thread_spawn: { parent_thread_id: parent, agent_path: path },
          },
        },
      },
    })}\n`,
  );
  return file;
}

afterEach(async () => {
  invalidateTranscriptCatalogCache();
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousCwd === undefined) delete process.env.CWD;
  else process.env.CWD = previousCwd;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("persisted subagent identity index", () => {
  test("reads child identity from bounded headers and rejects ambiguous paths", async () => {
    root = await mkdtemp(join(tmpdir(), "codex-subagent-index-"));
    await mkdir(join(root, "sessions"), { recursive: true });
    previousCodexHome = process.env.CODEX_HOME;
    previousCwd = process.env.CWD;
    process.env.CODEX_HOME = root;
    const first = await writeChild("child-one", "parent", "/root/one");
    await writeChild("child-two-a", "parent", "/root/two");
    await writeChild("child-two-b", "parent", "/root/two");
    await writeChild("other-parent", "other", "/root/one");

    expect(await getSessionMetaFromTranscriptPath(first)).toMatchObject({
      id: "child-one",
      parentThreadId: "parent",
      agentPath: "/root/one",
    });
    expect(
      Object.fromEntries(
        await resolvePersistedChildThreadIds("parent", ["/root/one", "/root/two"]),
      ),
    ).toEqual({ "/root/one": "child-one", "/root/two": null });
  });

  test("rehydrates successful and rejected spawns as agent cards after restart", async () => {
    root = await mkdtemp(join(tmpdir(), "codex-subagent-hydrate-"));
    await mkdir(join(root, "sessions"), { recursive: true });
    previousCodexHome = process.env.CODEX_HOME;
    previousCwd = process.env.CWD;
    process.env.CODEX_HOME = root;
    process.env.CWD = "/fixture";
    await writeChild("child-review", "parent", "/root/review");
    const parent = join(root, "sessions", "parent.jsonl");
    const response = (payload: Record<string, unknown>) => ({
      timestamp: "2026-09-07T09:57:00.000Z",
      type: "response_item",
      payload,
    });
    await writeFile(
      parent,
      `${[
        { type: "session_meta", payload: { id: "parent", cwd: "/fixture", source: "vscode" } },
        response({
          type: "function_call",
          name: "spawn_agent",
          call_id: "review-call",
          arguments: '{"task_name":"review"}',
        }),
        response({
          type: "function_call_output",
          call_id: "review-call",
          output: '{"task_name":"/root/review"}',
        }),
        response({
          type: "function_call",
          name: "spawn_agent",
          call_id: "rejected-call",
          arguments: '{"task_name":"rejected"}',
        }),
        response({
          type: "function_call_output",
          call_id: "rejected-call",
          output: "collab spawn failed: agent thread limit reached",
        }),
      ]
        .map((line) => JSON.stringify(line))
        .join("\n")}\n`,
    );

    const hydrated = await hydrateMessagesFromPersistedSession("parent");
    const parts = hydrated.messages.flatMap((message) => message.parts);
    expect(parts.filter((part) => part.type === "subagent")).toHaveLength(2);
    expect(parts.find((part) => part.subagentRole === "review")).toMatchObject({
      type: "subagent",
      subagentId: "child-review",
    });
    expect(parts.find((part) => part.subagentRole === "rejected")).toMatchObject({
      type: "subagent",
      toolState: "failure",
    });
    expect(parts.some((part) => part.toolName === "spawn_agent")).toBe(false);
  });

  test("keeps a path-only spawn pending when no child rollout can be discovered", async () => {
    const response = (payload: Record<string, unknown>) => ({
      timestamp: "2026-09-07T09:57:00.000Z",
      type: "response_item",
      payload,
    });
    const parts = await hydratePersistedSubagentParts(
      "parent",
      [
        { type: "session_meta", payload: { id: "parent", source: "vscode" } },
        response({
          type: "function_call",
          name: "spawn_agent",
          call_id: "missing-call",
          arguments: '{"task_name":"missing"}',
        }),
        response({
          type: "function_call_output",
          call_id: "missing-call",
          output: '{"task_name":"/root/missing"}',
        }),
      ],
      {
        resolveChildPaths: async () => new Map(),
        createTranscriptMetaLoader: () => async () => null,
        readTranscript: async () => {
          throw new Error("an unresolved child must not be read");
        },
      },
    );

    expect(parts.get("missing-call")).toMatchObject({
      type: "subagent",
      subagentId: undefined,
      toolState: "pending",
    });
  });

  test("bounds persisted child hydration by count and concurrency", async () => {
    const childCount = MAX_PERSISTED_SUBAGENT_TRANSCRIPTS + 8;
    const records = Array.from({ length: childCount }, (_, index) => [
      {
        timestamp: "2026-09-07T09:57:00.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          call_id: `call-${index}`,
          arguments: JSON.stringify({ task_name: `child-${index}` }),
        },
      },
      {
        timestamp: "2026-09-07T09:57:01.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: `call-${index}`,
          output: JSON.stringify({ agent_id: `child-${index}` }),
        },
      },
    ]).flat();
    let activeReads = 0;
    let maximumReads = 0;
    let totalReads = 0;

    const parts = await hydratePersistedSubagentParts("parent", records, {
      resolveChildPaths: async () => new Map(),
      createTranscriptMetaLoader: () => async (id) => ({ transcriptPath: id }),
      readTranscript: async () => {
        activeReads += 1;
        totalReads += 1;
        maximumReads = Math.max(maximumReads, activeReads);
        await new Promise((resolve) => setTimeout(resolve, 0));
        activeReads -= 1;
        return { records: [] };
      },
    });

    expect(totalReads).toBe(MAX_PERSISTED_SUBAGENT_TRANSCRIPTS);
    expect(maximumReads).toBeLessThanOrEqual(MAX_CONCURRENT_PERSISTED_SUBAGENT_READS);
    expect(parts.size).toBe(MAX_PERSISTED_SUBAGENT_TRANSCRIPTS);
    expect(parts.has("call-0")).toBe(false);
    expect(parts.has(`call-${childCount - 1}`)).toBe(true);
  });
});
