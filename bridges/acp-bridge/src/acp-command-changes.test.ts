import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";

// Must precede every bridge import below: `acp-context.js` resolves
// `ACP_PROVIDER` at module scope and throws without it.
import "./testing/unit-test-env.js";
import {
  nativeFetch,
  spawnBridge,
  stopChild,
  temporaryDirectory,
  waitFor,
} from "./acp-test-harness.js";
import type { MeasuredWorkspaceChange } from "@orkestrator/protocol/tool-diff";
import { RuntimeHealthRecorder } from "@orkestrator/protocol/runtime-health";
import {
  sessions,
  workingDirectory,
  type BridgeToolPart,
  type SessionState,
} from "./acp-context.js";
import {
  applyJournaledCommandChanges,
  configureCommandChanges,
  settleCommandChangeWindows,
  type CommandChangeProbe,
} from "./acp-command-changes.js";
import { applySessionUpdate } from "./acp-session.js";
import { emptySessionConfig, normalizeBridgePart } from "./acp-persistence.js";
import { reconcileStaleToolParts } from "./acp-reconciliation.js";

const CHANGE: MeasuredWorkspaceChange = {
  additions: 3,
  deletions: 1,
  files: [
    { path: "added.txt", additions: 2, deletions: 0 },
    { path: "notes.txt", additions: 1, deletions: 1 },
  ],
};

type ProbeCall = [method: string, ...args: unknown[]];

function fakeProbe(result: MeasuredWorkspaceChange | undefined = CHANGE): {
  probe: CommandChangeProbe;
  calls: ProbeCall[];
} {
  const calls: ProbeCall[] = [];
  const probe: CommandChangeProbe = {
    begin: async (cwd, callId, options) => {
      calls.push(["begin", cwd, callId, options]);
    },
    note: async (cwd, callId) => {
      calls.push(["note", cwd, callId]);
    },
    end: async (callId) => {
      calls.push(["end", callId]);
      return result;
    },
    discard: (callId) => {
      calls.push(["discard", callId]);
    },
    prime: async (cwd) => {
      calls.push(["prime", cwd]);
    },
  };
  return { probe, calls };
}

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

function send(state: SessionState, update: Record<string, unknown>): void {
  applySessionUpdate(state, { sessionId: state.acpSessionId, update });
}

function toolPart(state: SessionState, toolUseId: string): BridgeToolPart | undefined {
  return state.messages
    .flatMap((message) => message.parts)
    .find(
      (part): part is BridgeToolPart =>
        part.type === "tool-invocation" && part.toolUseId === toolUseId,
    );
}

/** Measurements land from a promise the update handler never awaits. */
async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await new Promise((done) => setTimeout(done, 0));
}

afterEach(() => {
  for (const id of Array.from(sessions.keys())) {
    if (id.startsWith("command-changes-")) sessions.delete(id);
  }
  configureCommandChanges({ probe: null, journalDirectory: null });
});

describe("measured shell command changes", () => {
  test("measures an execute call and keeps the badge through later updates", async () => {
    const { probe, calls } = fakeProbe();
    configureCommandChanges({ probe });
    const state = runningState("command-changes-execute");

    send(state, {
      sessionUpdate: "tool_call",
      toolCallId: "shell-1",
      title: "Run the codemod",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "./codemod.sh" },
    });
    // ACP reports a command only once it runs, so the window opens against the
    // latest snapshot rather than one taken now.
    expect(calls).toEqual([
      ["begin", workingDirectory, `${state.id}\u0000shell-1`, { baseline: true }],
    ]);

    send(state, { sessionUpdate: "tool_call_update", toolCallId: "shell-1", status: "completed" });
    expect(calls.at(-1)).toEqual(["end", `${state.id}\u0000shell-1`]);
    const revisionBeforeMeasurement = state.revision;
    await settle();
    expect(toolPart(state, "shell-1")?.commandChanges).toEqual(CHANGE);
    expect(state.revision).toBeGreaterThan(revisionBeforeMeasurement);

    // Every vendor frame re-renders the part from its source state; the
    // measurement must be part of that state or the next frame drops it.
    send(state, { sessionUpdate: "tool_call_update", toolCallId: "shell-1", title: "Codemod" });
    expect(toolPart(state, "shell-1")).toMatchObject({
      toolTitle: "Codemod",
      commandChanges: CHANGE,
    });
    expect(calls.filter(([method]) => method === "begin")).toHaveLength(1);
  });

  test("classifies Grok's shell tool from its vendor metadata", async () => {
    const { probe, calls } = fakeProbe();
    configureCommandChanges({ probe });
    const state = runningState("command-changes-grok");

    send(state, { sessionUpdate: "tool_call", toolCallId: "grok-shell", title: "Run tests" });
    expect(calls).toEqual([]);
    send(state, {
      sessionUpdate: "tool_call_update",
      toolCallId: "grok-shell",
      _meta: { "x.ai/tool": { name: "run_terminal_cmd" } },
    });
    expect(calls).toEqual([
      ["begin", workingDirectory, `${state.id}\u0000grok-shell`, { baseline: true }],
    ]);
  });

  test("notes edit calls without measuring them and skips background launches", async () => {
    const { probe, calls } = fakeProbe();
    configureCommandChanges({ probe });
    const state = runningState("command-changes-kinds");

    send(state, {
      sessionUpdate: "tool_call",
      toolCallId: "edit-1",
      title: "Edit notes.txt",
      kind: "edit",
      status: "pending",
    });
    send(state, { sessionUpdate: "tool_call_update", toolCallId: "edit-1", status: "completed" });
    await settle();
    expect(calls).toEqual([
      ["note", workingDirectory, `${state.id}\u0000edit-1`],
      ["end", `${state.id}\u0000edit-1`],
    ]);
    expect(toolPart(state, "edit-1")).not.toHaveProperty("commandChanges");

    calls.length = 0;
    send(state, {
      sessionUpdate: "tool_call",
      toolCallId: "server-1",
      title: "Start the dev server",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "bun dev", background: true },
    });
    send(state, { sessionUpdate: "tool_call_update", toolCallId: "server-1", status: "completed" });
    expect(calls).toEqual([]);

    // The launch flag can arrive after the call was first seen as a command.
    send(state, {
      sessionUpdate: "tool_call",
      toolCallId: "server-2",
      kind: "execute",
      status: "in_progress",
    });
    send(state, {
      sessionUpdate: "tool_call_update",
      toolCallId: "server-2",
      rawInput: { command: "bun dev", run_in_background: true },
    });
    send(state, { sessionUpdate: "tool_call_update", toolCallId: "server-2", status: "completed" });
    expect(calls.map(([method]) => method)).toEqual(["begin", "discard"]);
  });

  test("opens no window for replayed history or calls started by another process", () => {
    const { probe, calls } = fakeProbe();
    configureCommandChanges({ probe });
    const state = runningState("command-changes-replay");

    state.historyReplay = "hydrate";
    send(state, {
      sessionUpdate: "tool_call",
      toolCallId: "old-shell",
      kind: "execute",
      status: "completed",
    });
    state.historyReplay = false;
    // A late update for a call this process never saw start.
    send(state, {
      sessionUpdate: "tool_call_update",
      toolCallId: "old-shell",
      kind: "execute",
      status: "completed",
    });
    expect(calls).toEqual([]);
  });

  test("a turn end closes the windows of calls it settled", async () => {
    const { probe, calls } = fakeProbe();
    configureCommandChanges({ probe });
    const state = runningState("command-changes-turn-end");

    send(state, {
      sessionUpdate: "tool_call",
      toolCallId: "hang-1",
      kind: "execute",
      status: "in_progress",
    });
    reconcileStaleToolParts(state);
    settleCommandChangeWindows(state);
    await settle();
    expect(calls.at(-1)).toEqual(["end", `${state.id}\u0000hang-1`]);
    expect(toolPart(state, "hang-1")).toMatchObject({
      toolState: "failure",
      commandChanges: CHANGE,
    });
  });

  test("a command that changed nothing gets no badge and no journal entry", async () => {
    const journalDirectory = await temporaryDirectory();
    const { probe } = fakeProbe({ additions: 0, deletions: 0, files: [] });
    configureCommandChanges({ probe, journalDirectory });
    const state = runningState("command-changes-unchanged");

    send(state, {
      sessionUpdate: "tool_call",
      toolCallId: "ls-1",
      kind: "execute",
      status: "completed",
    });
    await settle();
    expect(toolPart(state, "ls-1")).not.toHaveProperty("commandChanges");
    expect(await fs.readdir(journalDirectory)).toEqual([]);
  });

  test("journals a measurement and lays it over a transcript rebuilt from replay", async () => {
    const journalDirectory = await temporaryDirectory();
    const { probe } = fakeProbe();
    configureCommandChanges({ probe, journalDirectory });
    const live = runningState("command-changes-journal");

    send(live, {
      sessionUpdate: "tool_call",
      toolCallId: "shell-1",
      kind: "execute",
      status: "completed",
    });
    await waitFor(
      async () => {
        const [file] = await fs.readdir(journalDirectory);
        return file ? fs.readFile(resolve(journalDirectory, file), "utf8") : "";
      },
      (contents) => contents.includes("shell-1"),
    );

    // A new bridge session for the same vendor session, as `session/load`
    // leaves it: the replayed call, and no measurement.
    const hydrated = runningState("command-changes-hydrated");
    hydrated.acpSessionId = live.acpSessionId;
    hydrated.status = "idle";
    hydrated.historyReplay = "hydrate";
    send(hydrated, {
      sessionUpdate: "tool_call",
      toolCallId: "shell-1",
      kind: "execute",
      status: "completed",
    });
    hydrated.historyReplay = false;
    expect(toolPart(hydrated, "shell-1")).not.toHaveProperty("commandChanges");

    const revision = hydrated.revision;
    expect(await applyJournaledCommandChanges(hydrated)).toBe(true);
    expect(toolPart(hydrated, "shell-1")?.commandChanges).toEqual(CHANGE);
    expect(hydrated.revision).toBeGreaterThan(revision);
    // The badge now lives on the source state, so later frames keep it.
    send(hydrated, { sessionUpdate: "tool_call_update", toolCallId: "shell-1", title: "Shell" });
    expect(toolPart(hydrated, "shell-1")?.commandChanges).toEqual(CHANGE);
  });

  test("the state-file normalizer keeps a valid measurement and drops a malformed one", () => {
    const base = {
      type: "tool-invocation",
      content: "Run",
      sourcePartId: "tool:shell-1",
      sourceMessageId: "message-1",
      toolUseId: "shell-1",
    };
    expect(normalizeBridgePart({ ...base, commandChanges: CHANGE }, 0, "message-1")).toMatchObject({
      commandChanges: CHANGE,
    });
    expect(
      normalizeBridgePart(
        { ...base, commandChanges: { additions: -1, files: [] } },
        0,
        "message-1",
      ),
    ).not.toHaveProperty("commandChanges");
    expect(
      normalizeBridgePart(
        { ...base, commandChanges: { additions: 0, deletions: 0, files: [] } },
        0,
        "message-1",
      ),
    ).not.toHaveProperty("commandChanges");
  });
});

describe("measured shell command changes through the bridge", () => {
  function git(cwd: string, ...args: string[]): void {
    execFileSync("git", args, { cwd, stdio: "ignore" });
  }

  test("measures a real command, restores it after restart, and re-applies it on reload", async () => {
    const repository = await temporaryDirectory();
    git(repository, "init", "--quiet");
    await fs.writeFile(resolve(repository, "notes.txt"), "one\ntwo\n");
    git(repository, "add", "notes.txt");
    git(
      repository,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--quiet",
      "-m",
      "notes",
    );
    const stateDirectory = await temporaryDirectory();
    const env = {
      CWD: repository,
      ACP_MEASURE_COMMAND_CHANGES: undefined,
      FAKE_ACP_REPLAY_SHELL_CHANGE: "1",
    };
    // `notes.txt` gains a line and rewrites one; `added.txt` is new.
    const expected = {
      additions: 4,
      deletions: 1,
      files: [
        { path: "added.txt", additions: 2, deletions: 0 },
        { path: "notes.txt", additions: 2, deletions: 1 },
      ],
    };
    type Session = { status: string; messages: Array<{ parts: Array<Record<string, unknown>> }> };
    const shellPart = (session: Session) =>
      session.messages
        .flatMap((message) => message.parts)
        .find((part) => part.toolUseId === "shell-change-1");

    const first = await spawnBridge({ stateDirectory, env });
    const created = (await nativeFetch(`${first.base}/session/create`, {
      method: "POST",
      headers: first.headers,
    }).then((response) => response.json())) as { id: string };
    await nativeFetch(`${first.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ prompt: "SHELLCHANGE" }),
    });
    const measured = await waitFor(
      async () =>
        nativeFetch(`${first.base}/session/${created.id}`, { headers: first.headers }).then(
          (response) => response.json(),
        ) as Promise<Session>,
      (session) => session.status === "idle" && shellPart(session)?.commandChanges !== undefined,
    );
    expect(shellPart(measured)?.commandChanges).toEqual(expected);

    // Restart: the state file carries the measurement.
    await waitFor(
      () => fs.readFile(resolve(stateDirectory, "state.json"), "utf8").catch(() => ""),
      (contents) => contents.includes("commandChanges"),
    );
    await stopChild(first.child);
    const second = await spawnBridge({ stateDirectory, env });
    const restored = (await nativeFetch(`${second.base}/session/${created.id}`, {
      headers: second.headers,
    }).then((response) => response.json())) as Session;
    expect(shellPart(restored)?.commandChanges).toEqual(expected);

    // Reload: release the tab, then adopt the vendor session again. The
    // transcript comes back from the agent's replay, the badge from the journal.
    const deleted = await nativeFetch(`${second.base}/session/${created.id}`, {
      method: "DELETE",
      headers: second.headers,
    });
    expect(deleted.status).toBe(200);
    const listed = (await nativeFetch(`${second.base}/session/list`, {
      headers: second.headers,
    }).then((response) => response.json())) as { sessions: Array<{ id: string; title?: string }> };
    const vendorSession = listed.sessions.find((session) => session.title === "Current ACP work");
    expect(vendorSession).toBeDefined();
    const resumed = await nativeFetch(`${second.base}/session/resume`, {
      method: "POST",
      headers: second.headers,
      body: JSON.stringify({ sessionId: vendorSession!.id }),
    });
    expect(resumed.status).toBe(201);
    const { sessionId } = (await resumed.json()) as { sessionId: string };
    const reloaded = (await nativeFetch(`${second.base}/session/${sessionId}`, {
      headers: second.headers,
    }).then((response) => response.json())) as Session;
    expect(shellPart(reloaded)?.commandChanges).toEqual(expected);
  });
});
