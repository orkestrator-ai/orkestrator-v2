import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CommandChangeJournal } from "@orkestrator/protocol/command-change-journal";
import type { MeasuredWorkspaceChange } from "@orkestrator/protocol/tool-diff";
import { newSessionState } from "./agent-session.js";
import {
  commandChangeExtension,
  discardToolCall,
  overlayCommandChanges,
  setCommandChangeProbeForTests,
  type CommandChangeProbe,
} from "./command-changes.js";
import { commandChangeJournalPath, workingDirectory } from "./config.js";
import type { BridgeToolPart, SessionState } from "./state.js";
import { applySessionEvent } from "./translate.js";

const CHANGE: MeasuredWorkspaceChange = {
  additions: 3,
  deletions: 1,
  files: [{ path: "src/a.ts", additions: 3, deletions: 1 }],
};

interface ProbeCall {
  method: "begin" | "note" | "end" | "discard";
  cwd?: string;
  id: string;
}

/** Records every call; `end` answers from `results`, keyed by window id. */
function fakeProbe(results: Map<string, MeasuredWorkspaceChange | undefined> = new Map()) {
  const calls: ProbeCall[] = [];
  const probe: CommandChangeProbe = {
    begin: async (cwd, id) => {
      calls.push({ method: "begin", cwd, id });
    },
    note: async (cwd, id) => {
      calls.push({ method: "note", cwd, id });
    },
    end: async (id) => {
      calls.push({ method: "end", id });
      return results.get(id);
    },
    discard: (id) => {
      calls.push({ method: "discard", id });
    },
  };
  return { probe, calls };
}

type Handler = (event: Record<string, unknown>) => Promise<unknown>;

/** Just enough of `ExtensionAPI` to capture what the factory registers. */
function registerHooks(state: SessionState): Record<string, Handler[]> {
  const handlers: Record<string, Handler[]> = {};
  const pi = {
    on: (event: string, handler: Handler) => {
      (handlers[event] ??= []).push(handler);
    },
  } as unknown as ExtensionAPI;
  commandChangeExtension(state)(pi);
  return handlers;
}

function running(): SessionState {
  const state = newSessionState();
  state.status = "running";
  state.piSessionId = "pi-session";
  return state;
}

function toolStart(toolCallId: string, toolName = "bash") {
  return { type: "tool_execution_start", toolCallId, toolName, args: { command: "sed -i x a" } };
}

function toolParts(state: SessionState): BridgeToolPart[] {
  return state.messages.flatMap((message) =>
    message.parts.filter((part): part is BridgeToolPart => part.type === "tool-invocation"),
  );
}

async function journaled(
  piSessionId: string,
  toolCallId: string,
): Promise<MeasuredWorkspaceChange | undefined> {
  const journal = new CommandChangeJournal(commandChangeJournalPath(piSessionId)!);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const change = (await journal.read()).get(toolCallId);
    if (change) return change;
    await Bun.sleep(5);
  }
  return undefined;
}

let stateDirectory: string;
let previousStateDirectory: string | undefined;

beforeEach(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), "pi-bridge-command-changes-"));
  previousStateDirectory = process.env.PI_BRIDGE_STATE_DIR;
  process.env.PI_BRIDGE_STATE_DIR = stateDirectory;
});

afterEach(async () => {
  setCommandChangeProbeForTests(undefined);
  if (previousStateDirectory === undefined) delete process.env.PI_BRIDGE_STATE_DIR;
  else process.env.PI_BRIDGE_STATE_DIR = previousStateDirectory;
  await rm(stateDirectory, { recursive: true, force: true });
});

describe("measuring hooks", () => {
  test("measures shell calls, notes edits and ignores everything else", async () => {
    const { probe, calls } = fakeProbe();
    setCommandChangeProbeForTests(probe);
    const state = running();
    const [toolCall] = registerHooks(state).tool_call!;

    await toolCall!({ toolCallId: "call-1", toolName: "bash", input: {} });
    await toolCall!({ toolCallId: "call-2", toolName: "powershell", input: {} });
    await toolCall!({ toolCallId: "call-3", toolName: "edit", input: {} });
    await toolCall!({ toolCallId: "call-4", toolName: "write", input: {} });
    await toolCall!({ toolCallId: "call-5", toolName: "read", input: {} });

    expect(calls).toEqual([
      { method: "begin", cwd: workingDirectory, id: `${state.id}:call-1` },
      { method: "begin", cwd: workingDirectory, id: `${state.id}:call-2` },
      { method: "note", cwd: workingDirectory, id: `${state.id}:call-3` },
      { method: "note", cwd: workingDirectory, id: `${state.id}:call-4` },
    ]);
  });

  test("never blocks or rewrites the call it measures", async () => {
    const { probe } = fakeProbe();
    setCommandChangeProbeForTests(probe);
    const hooks = registerHooks(running());

    expect(await hooks.tool_call![0]!({ toolCallId: "c", toolName: "bash", input: {} })).toBe(
      undefined,
    );
    expect(await hooks.tool_result![0]!({ toolCallId: "c", toolName: "bash" })).toBe(undefined);
  });

  test("stamps a measured change on the card, bumps the revision and journals it", async () => {
    const state = running();
    const { probe } = fakeProbe(new Map([[`${state.id}:call-1`, CHANGE]]));
    setCommandChangeProbeForTests(probe);
    applySessionEvent(state, toolStart("call-1"));
    const revision = state.revision;

    await registerHooks(state).tool_result![0]!({ toolCallId: "call-1", toolName: "bash" });

    expect(toolParts(state)[0]?.commandChanges).toEqual(CHANGE);
    expect(state.revision).toBeGreaterThan(revision);
    // The append is not awaited by the hook, so give it a moment to land.
    expect(await journaled("pi-session", "call-1")).toEqual(CHANGE);

    // The end frame re-renders the card and must keep the measurement.
    applySessionEvent(state, {
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "" }] },
      isError: false,
    });
    expect(toolParts(state)[0]).toMatchObject({ toolState: "success", commandChanges: CHANGE });
  });

  test("leaves an untouched or unmeasured call without a badge or journal", async () => {
    const state = running();
    const { probe } = fakeProbe(
      new Map([[`${state.id}:call-1`, { additions: 0, deletions: 0, files: [] }]]),
    );
    setCommandChangeProbeForTests(probe);
    applySessionEvent(state, toolStart("call-1"));
    applySessionEvent(state, toolStart("call-2"));
    const revision = state.revision;
    const [toolResult] = registerHooks(state).tool_result!;

    await toolResult!({ toolCallId: "call-1", toolName: "bash" });
    await toolResult!({ toolCallId: "call-2", toolName: "bash" });

    expect(toolParts(state).map((part) => part.commandChanges)).toEqual([undefined, undefined]);
    expect(state.revision).toBe(revision);
    await expect(readFile(commandChangeJournalPath("pi-session")!, "utf8")).rejects.toThrow();
  });

  test("holds a measurement that lands before its card and applies it on the first frame", async () => {
    const state = running();
    const { probe } = fakeProbe(new Map([[`${state.id}:call-1`, CHANGE]]));
    setCommandChangeProbeForTests(probe);

    await registerHooks(state).tool_result![0]!({ toolCallId: "call-1", toolName: "bash" });
    expect(toolParts(state)).toHaveLength(0);

    applySessionEvent(state, toolStart("call-1"));
    expect(toolParts(state)[0]?.commandChanges).toEqual(CHANGE);
    expect(state.pendingCommandChanges?.size ?? 0).toBe(0);
  });

  test("scopes windows to the bridge session so equal provider ids cannot collide", async () => {
    const { probe, calls } = fakeProbe();
    setCommandChangeProbeForTests(probe);
    const first = running();
    const second = running();

    await registerHooks(first).tool_call![0]!({ toolCallId: "call_0", toolName: "bash" });
    await registerHooks(second).tool_call![0]!({ toolCallId: "call_0", toolName: "bash" });
    discardToolCall(first, "call_0");

    expect(calls.map((call) => call.id)).toEqual([
      `${first.id}:call_0`,
      `${second.id}:call_0`,
      `${first.id}:call_0`,
    ]);
  });
});

describe("journal overlay", () => {
  function hydratedState(piSessionId: string): SessionState {
    const state = newSessionState();
    state.piSessionId = piSessionId;
    state.messages = [
      {
        id: "assistant-entry",
        role: "assistant",
        content: "",
        createdAt: "2026-09-27T00:00:00.000Z",
        parts: ["call-1", "call-2"].map((toolUseId, index) => ({
          type: "tool-invocation" as const,
          content: "sed -i x a",
          sourcePartId: `assistant-entry:${index}`,
          sourceMessageId: "assistant-entry",
          toolUseId,
          toolName: "bash",
          toolState: "success" as const,
        })),
      },
    ];
    return state;
  }

  test("puts journaled measurements back on the matching cards", async () => {
    await new CommandChangeJournal(commandChangeJournalPath("resumed")!).append("call-2", CHANGE);
    const state = hydratedState("resumed");
    const revision = state.revision;

    await overlayCommandChanges(state);

    expect(toolParts(state).map((part) => part.commandChanges)).toEqual([undefined, CHANGE]);
    expect(state.revision).toBe(revision + 1);
  });

  test("a fork inherits its parent's records and keeps them for its own resume", async () => {
    await new CommandChangeJournal(commandChangeJournalPath("parent")!).append("call-1", CHANGE);
    const forked = hydratedState("child");

    await overlayCommandChanges(forked, { inheritFrom: "parent" });

    expect(toolParts(forked)[0]?.commandChanges).toEqual(CHANGE);
    const own = await new CommandChangeJournal(commandChangeJournalPath("child")!).read();
    expect(own.get("call-1")).toEqual(CHANGE);
  });

  test("is a no-op for a stateless bridge", async () => {
    delete process.env.PI_BRIDGE_STATE_DIR;
    const state = hydratedState("resumed");
    const revision = state.revision;

    await overlayCommandChanges(state);

    expect(state.revision).toBe(revision);
    expect(commandChangeJournalPath("resumed")).toBeNull();
  });
});
