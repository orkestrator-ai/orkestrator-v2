/**
 * Shell-call line-change badges: which calls open which probe windows, and
 * where the measurement lands.
 *
 * The probe itself (git snapshots and diffs) is covered in
 * `packages/protocol`; here it is a recorder whose `end` answers what the test
 * says, so the wiring can be checked without a repository.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MeasuredWorkspaceChange } from "@orkestrator/protocol/tool-diff";
import { newSessionState } from "./agent-session.js";
import {
  trackCommandChanges,
  useCommandChangeProbeForTests,
  type CommandChangeProbe,
} from "./command-changes.js";
import { workingDirectory } from "./config.js";
import { drainPersistence, loadPersistedState, reopenPersistenceForTests } from "./persistence.js";
import { dispatchPrompt } from "./prompt.js";
import { clientSessionKeys, sessions, type BridgeToolPart, type SessionState } from "./state.js";
import { fakeAgent } from "./testing/fake-agent.js";
import { applyInteractionUpdate } from "./translate.js";

type ProbeCall =
  | { method: "prime"; cwd: string }
  | { method: "begin"; cwd: string; id: string; baseline?: boolean }
  | { method: "note"; cwd: string; id: string }
  | { method: "end"; id: string }
  | { method: "discard"; id: string };

interface RecordingProbe extends CommandChangeProbe {
  calls: ProbeCall[];
  results: Map<string, MeasuredWorkspaceChange>;
}

function recordingProbe(): RecordingProbe {
  const calls: ProbeCall[] = [];
  const results = new Map<string, MeasuredWorkspaceChange>();
  return {
    calls,
    results,
    prime: async (cwd) => void calls.push({ method: "prime", cwd }),
    begin: async (cwd, id, options) =>
      void calls.push({
        method: "begin",
        cwd,
        id,
        baseline: options?.baseline,
      }),
    note: async (cwd, id) => void calls.push({ method: "note", cwd, id }),
    end: async (id) => {
      calls.push({ method: "end", id });
      return results.get(id);
    },
    discard: (id) => void calls.push({ method: "discard", id }),
  };
}

const CHANGE: MeasuredWorkspaceChange = {
  additions: 3,
  deletions: 1,
  files: [{ path: "src/a.ts", additions: 3, deletions: 1 }],
};

let probe: RecordingProbe;
let restoreProbe: () => void;

beforeEach(() => {
  probe = recordingProbe();
  restoreProbe = useCommandChangeProbeForTests(probe);
});

afterEach(() => {
  restoreProbe();
});

function shellCall(command: string, workingDirectory?: string) {
  return {
    type: "shell",
    args: { command, ...(workingDirectory ? { workingDirectory } : {}) },
  };
}

function shellResult(command: string) {
  return {
    ...shellCall(command),
    result: {
      status: "success",
      value: {
        exitCode: 0,
        signal: "",
        stdout: "",
        stderr: "",
        executionTime: 1,
      },
    },
  };
}

/** Feed an update to both the transcript and the tracker, as `onDelta` does. */
function feed(
  state: SessionState,
  tracker: ReturnType<typeof trackCommandChanges>,
  update: object,
) {
  tracker.observe(update);
  applyInteractionUpdate(state, update);
}

function toolPart(state: SessionState, callId: string): BridgeToolPart | undefined {
  for (const message of state.messages) {
    for (const part of message.parts) {
      if (part.type === "tool-invocation" && part.toolUseId === callId) return part;
    }
  }
  return undefined;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("shell calls", () => {
  test("primes at turn start, opens a baseline window, and badges the card", async () => {
    const state = newSessionState();
    const tracker = trackCommandChanges(state);
    probe.results.set("c1", CHANGE);

    feed(state, tracker, {
      type: "tool-call-started",
      callId: "c1",
      toolCall: shellCall("sed -i x a"),
    });
    feed(state, tracker, {
      type: "tool-call-completed",
      callId: "c1",
      toolCall: shellResult("sed -i x a"),
    });
    const revision = state.revision;
    await settle();

    expect(probe.calls).toEqual([
      { method: "prime", cwd: workingDirectory },
      { method: "begin", cwd: workingDirectory, id: "c1", baseline: true },
      { method: "end", id: "c1" },
    ]);
    expect(toolPart(state, "c1")?.commandChanges).toEqual(CHANGE);
    expect(state.revision).toBe(revision + 1);
  });

  test("runs in the call's own working directory, resolved against the workspace", () => {
    const state = newSessionState();
    const tracker = trackCommandChanges(state);
    tracker.observe({
      type: "tool-call-started",
      callId: "rel",
      toolCall: shellCall("ls", "pkg"),
    });
    tracker.observe({
      type: "tool-call-started",
      callId: "abs",
      toolCall: shellCall("ls", "/elsewhere/repo"),
    });

    expect(probe.calls.filter((call) => call.method === "begin")).toEqual([
      {
        method: "begin",
        cwd: path.resolve(workingDirectory, "pkg"),
        id: "rel",
        baseline: true,
      },
      { method: "begin", cwd: "/elsewhere/repo", id: "abs", baseline: true },
    ]);
  });

  test("leaves an untouched worktree without a badge", async () => {
    const state = newSessionState();
    const tracker = trackCommandChanges(state);
    probe.results.set("c1", { additions: 0, deletions: 0, files: [] });

    feed(state, tracker, {
      type: "tool-call-started",
      callId: "c1",
      toolCall: shellCall("ls"),
    });
    feed(state, tracker, {
      type: "tool-call-completed",
      callId: "c1",
      toolCall: shellResult("ls"),
    });
    await settle();

    expect(toolPart(state, "c1")).toBeDefined();
    expect(toolPart(state, "c1")?.commandChanges).toBeUndefined();
  });

  test("waits for complete arguments rather than opening on a partial call", () => {
    const state = newSessionState();
    const tracker = trackCommandChanges(state);
    tracker.observe({
      type: "partial-tool-call",
      callId: "c1",
      toolCall: shellCall("ls", "/ho"),
    });
    expect(probe.calls.filter((call) => call.method === "begin")).toEqual([]);

    tracker.observe({
      type: "tool-call-started",
      callId: "c1",
      toolCall: shellCall("ls", "/home"),
    });
    tracker.observe({
      type: "tool-call-started",
      callId: "c1",
      toolCall: shellCall("ls", "/home"),
    });
    expect(probe.calls.filter((call) => call.method === "begin")).toEqual([
      { method: "begin", cwd: "/home", id: "c1", baseline: true },
    ]);
  });

  test("measures a call once even when its completion is re-reported", async () => {
    const state = newSessionState();
    const tracker = trackCommandChanges(state);
    const completed = { type: "tool-call-completed", callId: "c1", toolCall: shellResult("x") };
    tracker.observe({ type: "tool-call-started", callId: "c1", toolCall: shellCall("x") });
    tracker.observe(completed);
    tracker.observe(completed);
    await settle();

    expect(probe.calls.map((call) => call.method)).toEqual(["prime", "begin", "end"]);
  });

  test("still measures a call whose start was never reported", async () => {
    const state = newSessionState();
    const tracker = trackCommandChanges(state);
    probe.results.set("c1", CHANGE);

    feed(state, tracker, {
      type: "tool-call-completed",
      callId: "c1",
      toolCall: shellResult("x"),
    });
    await settle();

    expect(probe.calls.slice(1)).toEqual([
      { method: "begin", cwd: workingDirectory, id: "c1", baseline: true },
      { method: "end", id: "c1" },
    ]);
    expect(toolPart(state, "c1")?.commandChanges).toEqual(CHANGE);
  });

  test("badges a sub-agent's shell card", async () => {
    const state = newSessionState();
    const tracker = trackCommandChanges(state);
    probe.results.set("child", CHANGE);
    const nested = (taskUpdate: object) => ({
      type: "tool-call-delta",
      callId: "task-1",
      taskUpdate,
    });

    feed(
      state,
      tracker,
      nested({
        type: "tool-call-started",
        callId: "child",
        toolCall: shellCall("x"),
      }),
    );
    feed(
      state,
      tracker,
      nested({
        type: "tool-call-completed",
        callId: "child",
        toolCall: shellResult("x"),
      }),
    );
    await settle();

    const part = toolPart(state, "child");
    expect(part?.parentTaskUseId).toBe("task-1");
    expect(part?.commandChanges).toEqual(CHANGE);
  });

  test("skips a command that runs in the background", () => {
    const state = newSessionState();
    const tracker = trackCommandChanges(state);
    tracker.observe({
      type: "tool-call-started",
      callId: "bg",
      toolCall: {
        type: "shell",
        args: { command: "npm run dev", isBackground: true },
      },
    });
    expect(probe.calls.map((call) => call.method)).toEqual(["prime"]);
  });

  test("does not touch a session closed before the measurement arrived", async () => {
    const state = newSessionState();
    const tracker = trackCommandChanges(state);
    probe.results.set("c1", CHANGE);
    feed(state, tracker, {
      type: "tool-call-started",
      callId: "c1",
      toolCall: shellCall("x"),
    });
    state.closed = true;
    feed(state, tracker, {
      type: "tool-call-completed",
      callId: "c1",
      toolCall: shellResult("x"),
    });
    await settle();

    expect(toolPart(state, "c1")?.commandChanges).toBeUndefined();
  });
});

describe("other tools", () => {
  test("notes file edits so the next command's baseline excludes them", async () => {
    const state = newSessionState();
    const tracker = trackCommandChanges(state);
    for (const [callId, type] of [
      ["e1", "edit"],
      ["w1", "write"],
      ["d1", "delete"],
    ] as const) {
      tracker.observe({
        type: "tool-call-started",
        callId,
        toolCall: { type, args: { path: "a" } },
      });
      tracker.observe({
        type: "tool-call-completed",
        callId,
        toolCall: { type, args: { path: "a" } },
      });
    }
    await settle();

    expect(probe.calls.slice(1)).toEqual([
      { method: "note", cwd: workingDirectory, id: "e1" },
      { method: "end", id: "e1" },
      { method: "note", cwd: workingDirectory, id: "w1" },
      { method: "end", id: "w1" },
      { method: "note", cwd: workingDirectory, id: "d1" },
      { method: "end", id: "d1" },
    ]);
  });

  test("ignores tools that change nothing", () => {
    const state = newSessionState();
    const tracker = trackCommandChanges(state);
    tracker.observe({
      type: "tool-call-started",
      callId: "r1",
      toolCall: { type: "read", args: {} },
    });
    tracker.observe({
      type: "tool-call-completed",
      callId: "r1",
      toolCall: { type: "read", args: {} },
    });
    tracker.observe({
      type: "tool-call-started",
      toolCall: shellCall("no id"),
    });
    tracker.observe(null);
    expect(probe.calls.map((call) => call.method)).toEqual(["prime"]);
  });

  test("closing the turn drops windows whose completion never arrived", () => {
    const state = newSessionState();
    const tracker = trackCommandChanges(state);
    tracker.observe({
      type: "tool-call-started",
      callId: "lost",
      toolCall: shellCall("x"),
    });
    tracker.observe({
      type: "tool-call-started",
      callId: "done",
      toolCall: shellCall("y"),
    });
    tracker.observe({
      type: "tool-call-completed",
      callId: "done",
      toolCall: shellResult("y"),
    });
    tracker.close();

    expect(probe.calls.filter((call) => call.method === "discard")).toEqual([
      { method: "discard", id: "lost" },
    ]);
  });

  test("is inert without a probe", () => {
    restoreProbe();
    restoreProbe = useCommandChangeProbeForTests(null);
    const tracker = trackCommandChanges(newSessionState());
    tracker.observe({
      type: "tool-call-started",
      callId: "c1",
      toolCall: shellCall("x"),
    });
    tracker.close();
    expect(probe.calls).toEqual([]);
  });
});

describe("a dispatched turn", () => {
  test("measures the turn's shell calls and closes what it left open", async () => {
    const state = newSessionState();
    state.status = "running";
    probe.results.set("c1", CHANGE);
    const agent = fakeAgent({
      updates: [
        {
          type: "tool-call-started",
          callId: "c1",
          toolCall: shellCall("sed -i x a"),
        },
        {
          type: "tool-call-completed",
          callId: "c1",
          toolCall: shellResult("sed -i x a"),
        },
        {
          type: "tool-call-started",
          callId: "c2",
          toolCall: shellCall("sleep 100"),
        },
      ],
    });

    const handle = await dispatchPrompt(state, agent, {
      prompt: "go",
      images: [],
    });
    await handle.completion;
    await settle();

    expect(probe.calls[0]).toEqual({ method: "prime", cwd: workingDirectory });
    expect(toolPart(state, "c1")?.commandChanges).toEqual(CHANGE);
    expect(probe.calls).toContainEqual({ method: "discard", id: "c2" });
  });
});

describe("persistence", () => {
  let stateRoot: string;
  const previousStateDir = process.env.CURSOR_BRIDGE_STATE_DIR;

  beforeEach(async () => {
    sessions.clear();
    clientSessionKeys.clear();
    stateRoot = await mkdtemp(path.join(tmpdir(), "cursor-bridge-command-changes-"));
    process.env.CURSOR_BRIDGE_STATE_DIR = stateRoot;
  });

  afterEach(async () => {
    reopenPersistenceForTests();
    sessions.clear();
    clientSessionKeys.clear();
    if (previousStateDir === undefined) delete process.env.CURSOR_BRIDGE_STATE_DIR;
    else process.env.CURSOR_BRIDGE_STATE_DIR = previousStateDir;
    await rm(stateRoot, { recursive: true, force: true });
  });

  test("a measured badge is saved and survives a bridge restart", async () => {
    const state = newSessionState();
    sessions.set(state.id, state);
    const tracker = trackCommandChanges(state);
    probe.results.set("c1", CHANGE);
    feed(state, tracker, {
      type: "tool-call-started",
      callId: "c1",
      toolCall: shellCall("x"),
    });
    feed(state, tracker, {
      type: "tool-call-completed",
      callId: "c1",
      toolCall: shellResult("x"),
    });
    await settle();

    // The measurement schedules its own write: nothing else in this test does,
    // so the badge reaching disk before any drain is that write.
    const stateFile = path.join(stateRoot, "state.json");
    const deadline = Date.now() + 2_000;
    while (!(await readFile(stateFile, "utf8").catch(() => "")).includes("commandChanges")) {
      if (Date.now() >= deadline) throw new Error("The measured badge was never saved");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await drainPersistence();
    sessions.clear();
    await loadPersistedState();

    const restored = sessions.get(state.id);
    expect(restored && toolPart(restored, "c1")?.commandChanges).toEqual(CHANGE);
  });
});
