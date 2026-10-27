import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateUnifiedPatch, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  ChangeEvidenceEntry,
  ProviderEvidence,
  ProviderEvidenceFrame,
  WorkspaceObservationReport,
} from "@orkestrator/protocol/change-evidence";
import { CommandChangeJournal } from "@orkestrator/protocol/node/command-change-journal";
import type { ProbeObservation } from "@orkestrator/protocol/node/workspace-change-probe";
import type { MeasuredWorkspaceChange } from "@orkestrator/protocol/tool-diff";
import { newSessionState } from "./agent-session.js";
import {
  beginEvidenceTurn,
  PI_CHANGE_CAPABILITIES,
  recordToolResult,
  recordTurnEnded,
  recordTurnRunning,
  setChangeEvidenceForTests,
  type ChangeEvidenceRuntime,
} from "./change-evidence.js";
import {
  commandChangeExtension,
  discardToolCall,
  overlayCommandChanges,
  setCommandChangeProbeForTests,
  type CommandChangeProbe,
} from "./command-changes.js";
import { commandChangeJournalPath } from "./config.js";
import type { BridgeToolPart, SessionState } from "./state.js";
import { applySessionEvent } from "./translate.js";
import { settlePersistenceForTests } from "./persistence.js";

const CHANGE: MeasuredWorkspaceChange = {
  additions: 3,
  deletions: 1,
  files: [{ path: "src/a.ts", additions: 3, deletions: 1, status: "M" }],
};

type Handler = (event: Record<string, unknown>) => Promise<unknown>;

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

/** A probe whose every measured window observes `observation`. */
function fakeProbe(observation?: ProbeObservation) {
  const discarded: string[] = [];
  const probe: CommandChangeProbe = {
    begin: async () => undefined,
    note: async () => undefined,
    endObservation: async () => (observation ? structuredClone(observation) : undefined),
    discard: (id) => {
      discarded.push(id);
    },
  };
  return { probe, discarded };
}

let evidence: ChangeEvidenceRuntime;
let stateDirectory: string;
let previousStateDirectory: string | undefined;

beforeEach(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), "pi-bridge-change-evidence-"));
  previousStateDirectory = process.env.PI_BRIDGE_STATE_DIR;
  process.env.PI_BRIDGE_STATE_DIR = stateDirectory;
  evidence = setChangeEvidenceForTests({});
});

afterEach(async () => {
  setCommandChangeProbeForTests(undefined);
  // A spool on disk appends after the test returns.
  await evidence.spool.flush();
  setChangeEvidenceForTests(undefined);
  if (previousStateDirectory === undefined) delete process.env.PI_BRIDGE_STATE_DIR;
  else process.env.PI_BRIDGE_STATE_DIR = previousStateDirectory;
  await settlePersistenceForTests();
  await rm(stateDirectory, { recursive: true, force: true });
});

function entries(): ChangeEvidenceEntry[] {
  return evidence.spool.read(0).entries;
}

function frames(): ProviderEvidenceFrame[] {
  return entries().flatMap((entry) => (entry.type === "frame" ? [entry.frame] : []));
}

function observations(): WorkspaceObservationReport[] {
  return entries().flatMap((entry) => (entry.type === "observation" ? [entry.report] : []));
}

function toolFrames() {
  return frames().flatMap((frame) =>
    frame.event.kind === "tool" ? [{ source: frame.source, event: frame.event }] : [],
  );
}

function evidenceOf(frame: { event: { evidence: unknown[] } }): ProviderEvidence[] {
  return (frame.event.evidence as { kind: string; evidence?: ProviderEvidence }[]).flatMap(
    (update) => (update.kind === "replace" && update.evidence ? [update.evidence] : []),
  );
}

function bodyText(id: string): string | undefined {
  const bytes = evidence.spool.readBody(id);
  return bytes ? new TextDecoder().decode(bytes) : undefined;
}

describe("capabilities", () => {
  test("declares what Pi's hooks establish and leaves unverified facts unknown", () => {
    const declared = evidence.spool.read(0).capabilities;
    expect(declared).toHaveLength(1);
    expect(declared[0]).toMatchObject({
      ...PI_CHANGE_CAPABILITIES,
      beforeTool: "awaited",
      afterTool: "awaited",
      beforeTurn: "controlled-dispatch",
      afterTurn: "terminal-observed",
      turnDiff: "absent",
      captureExecutor: "unknown",
      captureAvailability: "ready",
    });
  });
});

describe("tool frames", () => {
  test("an edit result is provider-reported patch evidence with its body retained", async () => {
    setCommandChangeProbeForTests(fakeProbe().probe);
    const state = newSessionState();
    const hooks = registerHooks(state);
    const patch = generateUnifiedPatch("src/a.ts", "one\ntwo\n", "one\nTWO\nthree\n");
    const input = { path: "src/a.ts", edits: [{ oldText: "two", newText: "TWO\nthree" }] };

    await hooks.tool_call![0]!({ toolCallId: "edit-1", toolName: "edit", input });
    await hooks.tool_result![0]!({
      toolCallId: "edit-1",
      toolName: "edit",
      input,
      details: { diff: "-2 two\n+2 TWO\n+3 three", patch, firstChangedLine: 2 },
      isError: false,
    });

    const tools = toolFrames();
    expect(
      tools.map(({ event }) => [event.toolKind, event.phase, event.executionOccurrence]),
    ).toEqual([
      ["file-edit", "running", "started"],
      ["file-edit", "succeeded", "started"],
    ]);
    // Conversation is the bridge session the backend addresses; call is the
    // transcript part's `toolUseId`.
    expect(tools[1]!.source).toMatchObject({
      conversationId: state.id,
      callId: "edit-1",
      mode: "live",
    });
    const [result] = evidenceOf(tools[1]!);
    expect(result).toMatchObject({
      kind: "patch",
      path: "src/a.ts",
      format: "git_unified",
      effectClaim: "provider-reported",
    });
    if (result?.kind !== "patch") throw new Error("expected a patch");
    expect(result.body.state).toBe("available");
    expect(bodyText(result.body.id)).toBe(patch);
    // No edit-measured observation: an edit window is only noted.
    expect(observations()).toHaveLength(0);
  });

  test("a display-only edit diff is kept as opaque, never as a unified patch", () => {
    const state = newSessionState();
    recordToolResult(state, {
      toolCallId: "edit-2",
      toolName: "edit",
      input: { path: "a.txt" },
      details: { diff: "+1 hello" },
      isError: false,
    });
    const [result] = evidenceOf(toolFrames()[0]!);
    expect(result).toMatchObject({
      kind: "patch",
      format: "opaque",
      effectClaim: "provider-reported",
    });
  });

  test("a write's prior content is unknown, never an empty file", async () => {
    setCommandChangeProbeForTests(fakeProbe().probe);
    const state = newSessionState();
    const hooks = registerHooks(state);
    const input = { path: "notes.md", content: "hello\n" };

    await hooks.tool_call![0]!({ toolCallId: "write-1", toolName: "write", input });
    await hooks.tool_result![0]!({
      toolCallId: "write-1",
      toolName: "write",
      input,
      isError: false,
    });

    const [running, succeeded] = toolFrames();
    const [proposal] = evidenceOf(running!);
    expect(proposal).toMatchObject({
      kind: "replacement",
      path: "notes.md",
      before: { state: "unknown", reason: "prior-content-not-captured" },
      after: { state: "present" },
      extent: "whole-file",
      origin: "input",
      effectClaim: "proposal",
    });
    if (proposal?.kind !== "replacement" || proposal.after.state !== "present") {
      throw new Error("expected a replacement");
    }
    expect(bodyText(proposal.after.body.id)).toBe("hello\n");
    expect(succeeded!.event.phase).toBe("succeeded");
    const [applied] = evidenceOf(succeeded!);
    expect(applied).toMatchObject({
      kind: "replacement",
      before: { state: "unknown" },
      effectClaim: "provider-reported",
    });
  });

  test("a call blocked after the measuring hook did not run and has no observation", async () => {
    const { probe, discarded } = fakeProbe({
      change: CHANGE,
      boundary: { before: "fresh-before", after: "after-terminal" },
      overlap: "none-observed",
      omittedReasons: [],
    });
    setCommandChangeProbeForTests(probe);
    const state = newSessionState();
    const hooks = registerHooks(state);

    await hooks.tool_call![0]!({
      toolCallId: "bash-1",
      toolName: "bash",
      input: { command: "rm x" },
    });
    // A later `tool_call` handler blocks: Pi skips `tool_result` and ends the call.
    discardToolCall(state, "bash-1", {
      content: [{ type: "text", text: "Blocked by policy" }],
    });
    await hooks.tool_call![0]!({ toolCallId: "bash-2", toolName: "bash", input: { command: "x" } });
    discardToolCall(state, "bash-2", { content: [{ type: "text", text: "Operation aborted" }] });

    expect(discarded).toEqual([`${state.id}:bash-1`, `${state.id}:bash-2`]);
    expect(
      toolFrames().map(({ source, event }) => [
        source.callId,
        event.phase,
        event.executionOccurrence,
      ]),
    ).toEqual([
      ["bash-1", "running", "started"],
      ["bash-1", "denied", "did-not-run"],
      ["bash-2", "running", "started"],
      ["bash-2", "cancelled", "did-not-run"],
    ]);
    expect(observations()).toHaveLength(0);
  });

  test("an executed call that failed is failed and still observed", async () => {
    const observed: ProbeObservation = {
      change: CHANGE,
      boundary: { before: "fresh-before", after: "after-terminal" },
      overlap: "none-observed",
      omittedReasons: [],
    };
    setCommandChangeProbeForTests(fakeProbe(observed).probe);
    const state = newSessionState();
    state.status = "running";
    state.piSessionId = "pi-session";
    const hooks = registerHooks(state);
    applySessionEvent(state, {
      type: "tool_execution_start",
      toolCallId: "bash-3",
      toolName: "bash",
      args: {},
    });

    await hooks.tool_call![0]!({ toolCallId: "bash-3", toolName: "bash", input: {} });
    await hooks.tool_result![0]!({
      toolCallId: "bash-3",
      toolName: "bash",
      input: {},
      isError: true,
    });
    // The tool ran, so the end frame finds no open call to discard.
    discardToolCall(state, "bash-3", { content: [] });

    expect(toolFrames().map(({ event }) => event.phase)).toEqual(["running", "failed"]);
    const [report] = observations();
    expect(report).toMatchObject({
      source: { conversationId: state.id, callId: "bash-3" },
      boundary: { before: "fresh-before", after: "after-terminal" },
      overlap: "none-observed",
      outcome: { kind: "measured", additions: 3, deletions: 1, changedFiles: 1 },
    });
    // The legacy badge is unchanged by the evidence path.
    const part = state.messages
      .flatMap((message) => message.parts)
      .find((p): p is BridgeToolPart => p.type === "tool-invocation");
    expect(part?.commandChanges).toEqual(CHANGE);
  });

  test("a legacy badge is still marked approximate for an overlapped window", async () => {
    setCommandChangeProbeForTests(
      fakeProbe({
        change: CHANGE,
        boundary: { before: "fresh-before", after: "after-terminal" },
        overlap: "known-overlap",
        omittedReasons: [],
      }).probe,
    );
    const state = newSessionState();
    state.status = "running";
    applySessionEvent(state, {
      type: "tool_execution_start",
      toolCallId: "b",
      toolName: "bash",
      args: {},
    });
    await registerHooks(state).tool_result![0]!({ toolCallId: "b", toolName: "bash" });
    const part = state.messages
      .flatMap((message) => message.parts)
      .find((p): p is BridgeToolPart => p.type === "tool-invocation");
    expect(part?.commandChanges).toEqual({ ...CHANGE, approximate: true });
    expect(observations()[0]?.overlap).toBe("known-overlap");
  });

  test("read-only tools are not reported; nested calls name their parent", async () => {
    setCommandChangeProbeForTests(fakeProbe().probe);
    const state = newSessionState();
    const hooks = registerHooks(state);
    await hooks.tool_call![0]!({ toolCallId: "r", toolName: "read", input: { path: "a" } });
    await hooks.tool_result![0]!({ toolCallId: "r", toolName: "read", input: {}, isError: false });
    await hooks.tool_call![0]!({
      toolCallId: "child",
      toolName: "custom_tool",
      input: {},
      parentToolCallId: "parent",
    });
    expect(
      toolFrames().map(({ source, event }) => [source.callId, source.parentCallId, event.toolKind]),
    ).toEqual([["child", "parent", "other"]]);
  });

  test("tool frames carry the running turn, and turns report start and end", async () => {
    setCommandChangeProbeForTests(fakeProbe().probe);
    const state = newSessionState();
    beginEvidenceTurn(state, "pi:gen:1");
    recordTurnRunning(state, "pi:gen:1");
    await registerHooks(state).tool_call![0]!({ toolCallId: "c", toolName: "bash", input: {} });
    recordTurnEnded(state, "pi:gen:1", "succeeded");
    await registerHooks(state).tool_call![0]!({ toolCallId: "d", toolName: "bash", input: {} });

    const turns = frames().flatMap((frame) =>
      frame.event.kind === "turn"
        ? [[frame.source.turnId, frame.event.phase, frame.event.writerLiveness]]
        : [],
    );
    expect(turns).toEqual([
      ["pi:gen:1", "running", "may-write"],
      ["pi:gen:1", "succeeded", "unknown"],
    ]);
    expect(toolFrames().map(({ source }) => source.turnId)).toEqual(["pi:gen:1", undefined]);
  });
});

describe("spool", () => {
  test("a replayed result is deduplicated by its frame id", () => {
    const state = newSessionState();
    const event = {
      toolCallId: "e",
      toolName: "edit",
      input: { path: "a" },
      details: { patch: "--- a\n+++ a\n@@ -1 +1 @@\n-x\n+y\n" },
      isError: false,
    };
    recordToolResult(state, event);
    recordToolResult(state, event);
    expect(toolFrames()).toHaveLength(1);
  });

  test("unacknowledged evidence survives a restart beside the command journal", async () => {
    const directory = join(stateDirectory, "change-evidence");
    evidence = setChangeEvidenceForTests({ directory });
    const state = newSessionState();
    recordToolResult(state, {
      toolCallId: "e",
      toolName: "edit",
      input: { path: "a" },
      details: { patch: "--- a\n+++ a\n@@ -1 +1 @@\n-x\n+y\n" },
      isError: false,
    });
    const [frame] = frames();
    // Persistence is asynchronous; settle it as a clean shutdown would.
    await evidence.spool.flush();

    evidence = setChangeEvidenceForTests({ directory });
    const restored = frames();
    expect(restored.map((f) => f.frameId)).toEqual([frame!.frameId]);
    const [patch] = evidenceOf(toolFrames()[0]!);
    if (patch?.kind !== "patch") throw new Error("expected a patch");
    expect(bodyText(patch.body.id)).toContain("+y");
  });
});

describe("forks", () => {
  test("inherited parent operations produce no frames", async () => {
    await new CommandChangeJournal(commandChangeJournalPath("parent")!).append("call-1", CHANGE);
    const forked = newSessionState();
    forked.piSessionId = "child";
    forked.messages = [
      {
        id: "assistant-entry",
        role: "assistant",
        content: "",
        createdAt: "2026-10-20T00:00:00.000Z",
        parts: [
          {
            type: "tool-invocation",
            content: "sed -i x a",
            sourcePartId: "assistant-entry:0",
            sourceMessageId: "assistant-entry",
            toolUseId: "call-1",
            toolName: "bash",
            toolState: "success",
          },
        ],
      },
    ];

    await overlayCommandChanges(forked, { inheritFrom: "parent" });

    const part = forked.messages[0]!.parts[0] as BridgeToolPart;
    expect(part.commandChanges).toEqual(CHANGE);
    expect(entries()).toHaveLength(0);
  });
});

test("native call ids reused across turns retain separate transcript occurrences and observations", async () => {
  const state = newSessionState();
  const hooks = registerHooks(state);
  setCommandChangeProbeForTests(
    fakeProbe({
      change: CHANGE,
      boundary: { before: "fresh-before", after: "after-terminal" },
      overlap: "none-observed",
      omittedReasons: [],
    }).probe,
  );
  for (const [index, content] of ["same\n", "same\n", "different\n"].entries()) {
    beginEvidenceTurn(state, `turn-${index}`);
    // This is the row identity stamped on the transcript card by execution_start.
    state.toolCallRows = new Map([["reused", `assistant-${index}`]]);
    const event = { toolCallId: "reused", toolName: "write", input: { path: "a.txt", content } };
    await hooks.tool_call![0]!(event);
    await hooks.tool_result![0]!({ ...event, isError: false });
  }
  const successes = toolFrames().filter((f) => f.event.phase === "succeeded");
  expect(successes).toHaveLength(3);
  expect(successes.map((f) => f.source.attemptId)).toEqual([
    "assistant-0",
    "assistant-1",
    "assistant-2",
  ]);
  expect(successes.map((f) => f.source.turnId)).toEqual(["turn-0", "turn-1", "turn-2"]);
  expect(
    new Set(
      frames()
        .filter((f) => f.event.kind === "tool" && f.event.phase === "succeeded")
        .map((f) => f.frameId),
    ).size,
  ).toBe(3);
  for (const report of observations()) expect(report.source.attemptId).toBeDefined();
});
