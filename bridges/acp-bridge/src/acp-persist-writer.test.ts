import { afterAll, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import "./testing/unit-test-env.js";
import { RuntimeHealthRecorder } from "@orkestrator/protocol/runtime-health";
import type { SessionState } from "./acp-context.js";

const directory = await fs.mkdtemp(join(tmpdir(), "acp-writer-"));
process.env.ACP_STATE_DIR = directory;
const reservation = createServer();
await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const address = reservation.address();
if (!address || typeof address === "string") throw new Error("Missing test port");
process.env.PORT = String(address.port);
await new Promise<void>((resolve) => reservation.close(() => resolve()));
process.env.HOSTNAME = "127.0.0.1";
const { sessions, persistenceTail: initialTail } = await import("./acp-context.js");
const context = await import("./acp-context.js");
const { emptySessionConfig } = await import("./acp-persistence.js");
const writer = await import("./acp-persist-writer.js");
afterAll(async () => {
  await writer.flushStreamingPersist();
  sessions.clear();
  await fs.rm(directory, { recursive: true, force: true });
});
const read = async () => JSON.parse(await fs.readFile(join(directory, "state.json"), "utf8"));
function runningState(id: string): SessionState {
  const state: SessionState = {
    id,
    acpSessionId: `vendor-${id}`,
    status: "running",
    messages: [
      {
        id: `${id}-user`,
        role: "user",
        content: "go",
        parts: [],
        createdAt: new Date().toISOString(),
      },
    ],
    activeSubagentToolIds: new Set(),
    activeSubagentDescriptors: new Map(),
    settledCursorAgentIds: new Set(),
    subagentLimitExceeded: false,
    subagentToolIds: new Map(),
    cursorTodos: [],
    historyMessageIds: new Map(),
    child: null,
    revision: 0,
    structured: new Map(),
    promptJournal: new Map(),
    grokInterjectionJournal: new Map(),
    approvals: new Map(),
    interactions: new Map(),
    outputTruncated: false,
    uncheckedTranscriptBytes: 0,
    currentTurnOutput: null,
    promptSequence: 1,
    droppedMessages: 0,
    droppedParts: 0,
    transcriptTruncated: false,
    sessionConfig: emptySessionConfig(),
    dispatching: false,
    historyReplay: false,
    health: new RuntimeHealthRecorder(),
  };
  sessions.set(id, state);
  return state;
}

test("streaming bursts share a non-resetting timer and write the latest output", async () => {
  const state = runningState("batched");
  const timer = spyOn(globalThis, "setTimeout");
  try {
    writer.scheduleStreamingPersist();
    const scheduled = timer.mock.calls.find((call) => call[1] === 1000)!;
    state.messages[0]!.content = "latest output";
    writer.scheduleStreamingPersist();
    writer.scheduleStreamingPersist();
    expect(timer.mock.calls.filter((call) => call[1] === 1000)).toHaveLength(1);
    expect(context.persistenceTail).toBe(initialTail);
    // Execute the captured interval without depending on wall-clock timing.
    clearTimeout(timer.mock.results[0]!.value as ReturnType<typeof setTimeout>);
    (scheduled[0] as () => void)();
    await context.persistenceTail;
    expect((await read()).sessions[0].messages[0].content).toBe("latest output");
  } finally {
    timer.mockRestore();
    await writer.flushStreamingPersist();
  }
});

test("ordinary saves include output still waiting on the streaming timer", async () => {
  sessions.clear();
  const state = runningState("ordinary");
  writer.scheduleStreamingPersist();
  state.messages[0]!.content = "pending output";
  writer.schedulePersist();
  await context.persistenceTail;
  expect((await read()).sessions[0].messages[0].content).toBe("pending output");
  await writer.flushStreamingPersist();
});

test("shutdown flushes a late tool update from child teardown before the streaming timer fires", async () => {
  const { shutdown } = await import("./acp-server.js");
  sessions.clear();
  const state = runningState("shutdown");
  state.status = "idle";
  state.messages[0]!.role = "assistant";
  state.messages[0]!.parts = [
    {
      type: "tool-invocation",
      toolUseId: "late",
      toolName: "Task",
      toolState: "pending",
      content: "",
    },
  ];
  await writer.persistState();
  state.child = {
    close: async () => {
      state.messages[0]!.parts![0]!.toolState = "success";
      state.messages[0]!.parts![0]!.content = "late subagent result";
      state.revision += 1;
      writer.scheduleStreamingPersist();
    },
  } as unknown as SessionState["child"];
  const timer = spyOn(globalThis, "setTimeout");
  try {
    await shutdown();
    expect(timer.mock.calls.some((call) => call[1] === 1000)).toBe(true);
    const saved = (await read()).sessions[0];
    expect(saved.status).toBe("idle");
    expect(saved.messages[0].parts[0]).toMatchObject({
      toolState: "success",
      content: "late subagent result",
    });
    state.child = null;
    sessions.clear();
    const { restorePersistedState } = await import("./acp-persistence.js");
    await restorePersistedState();
    expect(sessions.get("shutdown")?.messages[0]?.parts?.[0]).toMatchObject({
      toolState: "success",
      content: "late subagent result",
    });
    expect(sessions.get("shutdown")?.status).toBe("idle");
  } finally {
    timer.mockRestore();
  }
});
