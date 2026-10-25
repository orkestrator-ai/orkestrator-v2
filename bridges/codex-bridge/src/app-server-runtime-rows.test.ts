import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import {
  buildRecoveredContextPrompt,
  type HistoricalAssistantSegmentState,
  MAX_HELD_ASSISTANT_ROWS,
  MAX_TRACKED_ASSISTANT_ROWS,
} from "./app-server-runtime-base.js";
import { MAX_DIFF_CACHE_ENTRIES } from "./messages/diff-budget.js";
import { segmentNeedsRender } from "./app-server-runtime-rows.js";
import {
  createTurnRenderState,
  renderTurn,
  SUBAGENT_TRANSCRIPT_PROBE_INTERVAL_MS,
} from "./messages/render-turn.js";
import type { NormalizedMessage } from "./messages/types.js";
import { TurnAccumulator } from "./sessions/turn-accumulator.js";
import { registerCodexTranscriptRoutes } from "./transcript-routes.js";

import { harness, threadPayload, type Harness } from "./app-server-runtime-test-harness.js";

const TURN_STARTED_MS = Date.parse("2026-10-14T10:00:00.000Z");

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
    ...(status === "completed" ? { exitCode: 0 } : {}),
  };
}

/** One model response: it reasons, then calls a command. */
function response(h: Harness, step: number, options: { completeCommand?: boolean } = {}): void {
  const reasoning = { id: `r${step}`, type: "reasoning", summary: [`step ${step}`], content: [] };
  notifyItem(h, "item/started", reasoning, { startedAtMs: TURN_STARTED_MS + step * 1_000 });
  notifyItem(h, "item/completed", reasoning);
  notifyItem(h, "item/started", command(`c${step}`, "inProgress"));
  if (options.completeCommand ?? true) {
    notifyItem(h, "item/completed", command(`c${step}`, "completed"));
  }
}

async function assistantRows(h: Harness, sessionId: string): Promise<NormalizedMessage[]> {
  return (await h.runtime.getMessages(sessionId))!.filter(
    (message) => message.role === "assistant",
  );
}

function patchesFor(h: Harness, messageId: string, from = 0) {
  return h.events
    .slice(from)
    .filter(
      (event) =>
        event.type === "message.patched" &&
        (event.data as { messageId?: string }).messageId === messageId,
    );
}

function toolState(row: NormalizedMessage | undefined, toolUseId: string) {
  return row?.parts.find((part) => part.toolUseId === toolUseId)?.toolState;
}

describe("one assistant row per model response", () => {
  test("a multi-step turn publishes one row per response, in order", async () => {
    const { h, sessionId } = await startTurn();
    response(h, 1);
    response(h, 2);
    const answer = { id: "answer", type: "agentMessage", text: "All done" };
    notifyItem(h, "item/started", answer, { startedAtMs: TURN_STARTED_MS + 3_000 });
    notifyItem(h, "item/completed", answer);
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    const rows = await assistantRows(h, sessionId);
    expect(rows.map((row) => row.parts.map((part) => part.toolUseId ?? part.type))).toEqual([
      ["thinking", "c1"],
      ["thinking", "c2"],
      ["text"],
    ]);
    expect(rows.map((row) => row.content)).toEqual(["", "", "All done"]);
    expect(rows.every((row) => row.turnId === "turn-1")).toBe(true);
    // A response's row starts when app-server says its first item did.
    expect(rows[1]?.createdAt).toBe(new Date(TURN_STARTED_MS + 2_000).toISOString());
    expect(rows[2]?.createdAt).toBe(new Date(TURN_STARTED_MS + 3_000).toISOString());

    // Every row is sent whole before any patch for it, and rows are
    // announced in transcript order.
    const announced: string[] = [];
    for (const event of h.events) {
      const data = event.data as { message?: NormalizedMessage; messageId?: string } | undefined;
      if (event.type === "message.updated" && data?.message?.role === "assistant") {
        if (!announced.includes(data.message.id)) announced.push(data.message.id);
      }
      if (event.type === "message.patched") expect(announced).toContain(data!.messageId!);
    }
    expect(announced).toEqual(rows.map((row) => row.id));
  });

  test("a command finishing after the next response began re-renders its own row", async () => {
    const { h, sessionId } = await startTurn();
    response(h, 1, { completeCommand: false });
    response(h, 2);
    await h.drain();
    let rows = await assistantRows(h, sessionId);
    expect(toolState(rows[0], "c1")).toBe("pending");

    const before = h.events.length;
    notifyItem(h, "item/completed", command("c1", "completed"));
    await h.drain();

    rows = await assistantRows(h, sessionId);
    expect(toolState(rows[0], "c1")).toBe("success");
    expect(rows[0]?.parts.find((part) => part.toolUseId === "c1")?.toolOutput).toBe("output of c1");
    expect(patchesFor(h, rows[0]!.id, before)).toHaveLength(1);
    // The rows that did not move are not sent again.
    expect(patchesFor(h, rows[1]!.id, before)).toHaveLength(0);
  });

  test("rows well past the old limit of eight keep taking late updates", async () => {
    const { h, sessionId } = await startTurn();
    for (let step = 1; step <= 12; step += 1) response(h, step, { completeCommand: false });
    await h.drain();

    notifyItem(h, "item/completed", command("c2", "completed"));
    notifyItem(h, "item/completed", command("c11", "completed"));
    await h.drain();

    const rows = await assistantRows(h, sessionId);
    expect(rows).toHaveLength(12);
    expect(toolState(rows[1], "c2")).toBe("success");
    expect(toolState(rows[10], "c11")).toBe("success");
    expect(toolState(rows[0], "c1")).toBe("pending");
  });

  test("a row past the tracking bound still takes its late updates", async () => {
    const { h, sessionId } = await startTurn();
    response(h, 1, { completeCommand: false });
    for (let step = 2; step <= MAX_TRACKED_ASSISTANT_ROWS + 4; step += 1) response(h, step);
    await h.drain();
    expect(trackedRows(h).size).toBeLessThanOrEqual(MAX_TRACKED_ASSISTANT_ROWS);
    expect(trackedRows(h).has((await assistantRows(h, sessionId))[0]!.id)).toBe(false);

    const first = (await assistantRows(h, sessionId))[0]!;
    const before = h.events.length;
    h.child().notify("item/commandExecution/outputDelta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "c1",
      delta: "still running",
    });
    await h.drain();
    expect(
      (await assistantRows(h, sessionId))[0]?.parts.find((part) => part.toolUseId === "c1")
        ?.toolOutput,
    ).toBe("still running");

    notifyItem(h, "item/completed", command("c1", "completed"));
    const answer = { id: "answer", type: "agentMessage", text: "Finished" };
    notifyItem(h, "item/completed", answer);
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    const rows = await assistantRows(h, sessionId);
    expect(rows[0]?.id).toBe(first.id);
    expect(toolState(rows[0], "c1")).toBe("success");
    expect(rows[0]?.parts.find((part) => part.toolUseId === "c1")?.toolOutput).toBe("output of c1");
    expect(patchesFor(h, first.id, before)).toHaveLength(2);
    expect(rows).toHaveLength(MAX_TRACKED_ASSISTANT_ROWS + 5);
    expect(rows.at(-1)?.content).toBe("Finished");
    expect(h.runtime.getStatus(sessionId)).toMatchObject({ phase: "idle" });
  });
});

describe("a row tracked again", () => {
  function diffOf(row: NormalizedMessage | undefined, toolUseId: string) {
    return row?.parts.find((part) => part.toolUseId === toolUseId)?.toolDiff;
  }

  test("keeps the diffs it published, however far later edits moved the file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "codex-rows-diff-"));
    try {
      await writeFile(join(cwd, "a.txt"), "one\n");
      const h = await harness({
        "thread/start": () => ({ thread: threadPayload("thread-1", { cwd }) }),
      });
      const { sessionId } = h.runtime.createSession({ mode: "build" });
      await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });
      // The first response adds a.txt and leaves a command running.
      notifyItem(h, "item/completed", {
        id: "add",
        type: "fileChange",
        status: "completed",
        // app-server's own payload for an add is the new file's content.
        changes: [{ path: "a.txt", kind: { type: "add" }, diff: "one\n" }],
      });
      notifyItem(h, "item/started", command("c1", "inProgress"));
      await h.drain();
      const first = (await assistantRows(h, sessionId))[0]!;
      const published = diffOf(first, "add");
      expect(published).toMatchObject({ additions: 1, deletions: 0 });
      expect(published?.diff).toContain("+one");

      // Enough later responses to let the row go, and edits to a.txt enough
      // to push the add out of the turn's diff cache.
      for (let step = 2; step <= MAX_TRACKED_ASSISTANT_ROWS + 4; step += 1) response(h, step);
      notifyItem(h, "item/completed", {
        id: "edits",
        type: "fileChange",
        status: "completed",
        changes: Array.from({ length: MAX_DIFF_CACHE_ENTRIES + 44 }, () => ({
          path: "a.txt",
          kind: { type: "update" },
          diff: "@@ -1 +1 @@\n-one\n+two\n",
        })),
      });
      await h.drain();
      expect(trackedRows(h).has(first.id)).toBe(false);

      // The command finishing tracks the row again; only it renders anew.
      notifyItem(h, "item/completed", command("c1", "completed"));
      await h.drain();
      let row = (await assistantRows(h, sessionId))[0]!;
      expect(toolState(row, "c1")).toBe("success");
      expect(diffOf(row, "add")).toEqual(published);

      h.child().notify("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      });
      await h.drain();
      row = (await assistantRows(h, sessionId))[0]!;
      expect(diffOf(row, "add")).toEqual(published);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("a sub-agent card let go mid-run is settled when the turn ends", async () => {
    const { h, sessionId } = await startTurn();
    const spawned = MAX_TRACKED_ASSISTANT_ROWS + MAX_HELD_ASSISTANT_ROWS + 2;
    const children: string[] = [];
    // One response per agent, each still running: every row waits on one.
    for (let step = 0; step < spawned; step += 1) {
      const reasoning = {
        id: `r${step}`,
        type: "reasoning",
        summary: [`step ${step}`],
        content: [],
      };
      if (step > 0) notifyItem(h, "item/completed", reasoning);
      children.push(`child-${step}`);
      notifyItem(h, "item/completed", {
        id: `spawn-${step}`,
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        receiverThreadIds: [`child-${step}`],
        agentsStates: {},
        status: "completed",
      });
    }
    await h.drain();
    const first = (await assistantRows(h, sessionId))[0]!;
    const card = (row: NormalizedMessage | undefined) =>
      row?.parts.find((part) => part.type === "subagent" && part.subagentId === "child-0");
    expect(card(first)?.toolState).toBe("pending");
    // Past the rows held for their agents, so no probe reaches it any more.
    expect(trackedRows(h).has(first.id)).toBe(false);

    // Every agent finishes, and the turn with them.
    notifyItem(h, "item/completed", { id: "r-final", type: "reasoning", summary: ["wait"] });
    notifyItem(h, "item/completed", {
      id: "wait",
      type: "collabAgentToolCall",
      tool: "wait",
      receiverThreadIds: children,
      agentsStates: Object.fromEntries(children.map((id) => [id, { status: "completed" }])),
      status: "completed",
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    expect(card((await assistantRows(h, sessionId))[0])?.toolState).toBe("success");
  });
});

function trackedRows(h: Harness): Map<string, unknown> {
  return (
    h.runtime as unknown as {
      threadState: Map<string, { historicalAssistantSegments: Map<string, unknown> }>;
    }
  ).threadState.get("thread-1")!.historicalAssistantSegments;
}

describe("sub-agent probes on frozen rows", () => {
  const spawn = {
    id: "spawn",
    type: "collab_tool_call" as const,
    tool: "spawn_agent",
    receiver_thread_ids: ["child-1"],
    status: "completed" as const,
  };
  const later = Date.now() + SUBAGENT_TRANSCRIPT_PROBE_INTERVAL_MS * 10;

  /** Row 1 spawned `child-1`; the probe found its card in `toolState`. */
  async function frozenRowWithCard(toolState: "pending" | "success") {
    const turn = new TurnAccumulator({
      threadId: "thread-1",
      turnId: "turn-1",
      engineGeneration: 1,
      assistantMessageId: "row-1",
    });
    turn.onItemCompleted(spawn);
    turn.startModelStep("row-2", "2026-10-14T10:00:05.000Z");
    const segment = turn.findAssistantSegment("row-1")!;
    const render = createTurnRenderState();
    await renderTurn(turn, {
      threadId: "thread-1",
      cwd: "/tmp",
      state: render,
      segment,
      loadSubagentParts: async () => [
        { type: "subagent", content: "child", toolState, subagentId: "child-1" },
      ],
    });
    const historical: HistoricalAssistantSegmentState = {
      render,
      publishedParts: [],
      announced: true,
      renderedItemVersion: turn.assistantSegmentVersion("row-1"),
    };
    return { turn, segment, historical };
  }

  test("a row whose sub-agents have all finished is not probed again", async () => {
    const { turn, segment, historical } = await frozenRowWithCard("success");
    expect(segmentNeedsRender(turn, segment, historical, later)).toBe(false);
  });

  test("a row with a running sub-agent keeps probing", async () => {
    const { turn, segment, historical } = await frozenRowWithCard("pending");
    expect(segmentNeedsRender(turn, segment, historical, later)).toBe(true);
  });

  test("a later wait or message to one of its agents probes it again", async () => {
    const { turn, segment, historical } = await frozenRowWithCard("success");
    turn.onItemCompleted({
      id: "send",
      type: "collab_tool_call",
      tool: "send_input",
      receiver_thread_ids: ["child-1"],
      status: "completed",
    });
    expect(segmentNeedsRender(turn, segment, historical, later)).toBe(true);
  });
});

describe("revised rows before the live window", () => {
  test("a late change to a row outside the window travels with the next snapshot", async () => {
    const { h, sessionId } = await startTurn();
    response(h, 1, { completeCommand: false });
    for (let step = 2; step <= 30; step += 1) response(h, step);
    await h.drain();
    const app = new Hono();
    registerCodexTranscriptRoutes(app, h.runtime);
    const read = async (params: Record<string, string>): Promise<any> =>
      (await app.request(`/session/${sessionId}/transcript?${new URLSearchParams(params)}`)).json();
    const window = { version: "2", limit: "10", targetBytes: String(512 * 1024) };
    const first = (await assistantRows(h, sessionId))[0]!;

    const before = await read(window);
    expect(before.value.startIndex).toBeGreaterThan(1);
    expect(before.value.messages.map((message: NormalizedMessage) => message.id)).not.toContain(
      first.id,
    );

    // The command in the first response finishes 29 responses later.
    notifyItem(h, "item/completed", command("c1", "completed"));
    await h.drain();

    const after = await read({ ...window, knownToken: before.token });
    expect(after.status).toBe("snapshot");
    const [revised] = after.value.revisedMessages as NormalizedMessage[];
    expect(revised?.id).toBe(first.id);
    expect(toolState(revised, "c1")).toBe("success");

    // A new history names none of the rows noted against the old one.
    const registry = (
      h.runtime as unknown as {
        registry: { bumpContentEpoch(session: unknown): void; getSession(id: string): unknown };
      }
    ).registry;
    registry.bumpContentEpoch(registry.getSession(sessionId));
    expect((await read(window)).value.revisedMessages).toBeUndefined();
  });
});

describe("noted rows", () => {
  test("rows written only while they were the newest are not carried", async () => {
    const { h, sessionId } = await startTurn();
    // Each response is published in full before the next one opens its row.
    for (let step = 1; step <= 30; step += 1) {
      response(h, step);
      await h.drain();
    }
    const app = new Hono();
    registerCodexTranscriptRoutes(app, h.runtime);
    const response_ = await app.request(
      `/session/${sessionId}/transcript?version=2&limit=10&targetBytes=${512 * 1024}`,
    );
    const body = (await response_.json()) as {
      value: { startIndex: number } & Record<string, unknown>;
    };
    expect(body.value.startIndex).toBeGreaterThan(1);
    expect(body.value.revisedMessages).toBeUndefined();
    expect(h.runtime.getRevisedMessageIds(sessionId)).toEqual([]);
  });
});

describe("recovered context", () => {
  test("joins a turn's assistant rows into one reply", () => {
    const row = (id: string, text: string, turnId?: string): NormalizedMessage => ({
      id,
      role: "assistant",
      content: text,
      parts: text ? [{ type: "text", content: text }] : [],
      createdAt: "2026-10-14T10:00:00.000Z",
      ...(turnId ? { turnId } : {}),
    });
    const prompt = buildRecoveredContextPrompt(
      [
        { ...row("u1", "Fix it", "turn-1"), role: "user" },
        row("a1", "Looking at the logs.", "turn-1"),
        row("a2", "", "turn-1"),
        row("a3", "Fixed.", "turn-1"),
        { ...row("u2", "Thanks", "turn-2"), role: "user" },
        row("a4", "Anytime.", "turn-2"),
      ],
      "next",
    );
    expect(prompt).toContain(
      "USER:\nFix it\n\nASSISTANT:\nLooking at the logs.\nFixed.\n\nUSER:\nThanks\n\nASSISTANT:\nAnytime.",
    );
  });
});
