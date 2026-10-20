import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// Must precede every bridge import below: `acp-context.js` resolves
// `ACP_PROVIDER` at module scope and throws without it.
import "./testing/unit-test-env.js";
import { nativeFetch, spawnBridge, temporaryDirectory, waitFor } from "./acp-test-harness.js";
import type {
  ChangeEvidenceEntry,
  ChangeEvidenceReadResponse,
  ProviderEvidenceFrame,
  ProviderEvidenceUpdate,
  WorkspaceObservationReport,
} from "@orkestrator/protocol/change-evidence";
import { ChangeEvidenceSpool } from "@orkestrator/protocol/node/change-tracking/evidence-spool";
import type { ProbeObservation } from "@orkestrator/protocol/node/workspace-change-probe";
import { RuntimeHealthRecorder } from "@orkestrator/protocol/runtime-health";
import { sessions, type BridgeToolPart, type SessionState } from "./acp-context.js";
import { configureCommandChanges, type CommandChangeProbe } from "./acp-command-changes.js";
import { emptySessionConfig } from "./acp-persistence.js";
import { reconcileStaleToolParts } from "./acp-reconciliation.js";
import { applySessionUpdate } from "./acp-session.js";
import { GROK_RUNTIME, genericAcpRuntime } from "./acp-tool-classification.js";
import {
  acpCaptureExecutor,
  acpChangeCapabilities,
  beginAcpTurnEvidence,
  configureChangeEvidence,
  endAcpTurnEvidence,
  recordAcpToolApproval,
} from "./change-evidence.js";

let spool: ChangeEvidenceSpool;

beforeEach(() => {
  spool = new ChangeEvidenceSpool();
  configureChangeEvidence({ spool, measurementEnabled: true, runtime: GROK_RUNTIME });
});

afterEach(() => {
  for (const id of Array.from(sessions.keys())) {
    if (id.startsWith("evidence-")) sessions.delete(id);
  }
  configureCommandChanges({ probe: null, journalDirectory: null });
  configureChangeEvidence({ spool: null });
});

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

function entries(from = spool): ChangeEvidenceEntry[] {
  return from.read(0, 1_000).entries;
}

function frames(from = spool): ProviderEvidenceFrame[] {
  return entries(from).flatMap((entry) => (entry.type === "frame" ? [entry.frame] : []));
}

function toolFrames(callId?: string): Array<
  ProviderEvidenceFrame & {
    event: Extract<ProviderEvidenceFrame["event"], { kind: "tool" }>;
  }
> {
  return frames().filter(
    (
      frame,
    ): frame is ProviderEvidenceFrame & {
      event: Extract<ProviderEvidenceFrame["event"], { kind: "tool" }>;
    } => frame.event.kind === "tool" && (callId === undefined || frame.source.callId === callId),
  );
}

function replaces(frame: { event: { evidence: ProviderEvidenceUpdate[] } }) {
  return frame.event.evidence.filter(
    (update): update is Extract<ProviderEvidenceUpdate, { kind: "replace" }> =>
      update.kind === "replace",
  );
}

function bodyText(id: string): string | undefined {
  const bytes = spool.readBody(id);
  return bytes ? new TextDecoder().decode(bytes) : undefined;
}

function toolPart(state: SessionState, toolUseId: string): BridgeToolPart | undefined {
  return state.messages
    .flatMap((message) => message.parts)
    .find(
      (part): part is BridgeToolPart =>
        part.type === "tool-invocation" && part.toolUseId === toolUseId,
    );
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await new Promise((done) => setTimeout(done, 0));
}

describe("ACP change evidence", () => {
  test("keeps every diff block of one call as its own evidence, with its path", () => {
    const state = runningState("evidence-multi");
    send(state, {
      sessionUpdate: "tool_call",
      toolCallId: "multi-1",
      title: "Edit three files",
      kind: "edit",
      status: "completed",
      content: [
        { type: "diff", path: "/repo/src/first.ts", oldText: "a\nb\n", newText: "a\nc\n" },
        { type: "diff", path: "/repo/src/second.ts", oldText: "x\n", newText: "y\n" },
        // The same file edited twice in one call: two blocks, never summed.
        { type: "diff", path: "/repo/src/first.ts", oldText: "a\nc\n", newText: "a\nd\n" },
        {
          type: "diff",
          path: "/repo/src/patched.ts",
          oldText: "old\n",
          newText: "new\n",
          diff: "--- a/src/patched.ts\n+++ b/src/patched.ts\n@@ -1 +1 @@\n-old\n+new\n",
        },
      ],
    });

    const [frame] = toolFrames("multi-1");
    expect(frame).toBeDefined();
    expect(frame!.source.conversationId).toBe(state.id);
    expect(frame!.source.conversationId).not.toBe(state.acpSessionId);
    expect(frame!.event).toMatchObject({
      toolKind: "file-edit",
      phase: "succeeded",
      executionOccurrence: "started",
    });
    const updates = replaces(frame!);
    expect(updates.map((update) => update.evidenceKey)).toEqual([
      "diff:/repo/src/first.ts:0",
      "diff:/repo/src/second.ts:0",
      "diff:/repo/src/first.ts:1",
      "diff:/repo/src/patched.ts:0",
      "patch:/repo/src/patched.ts:0",
    ]);
    const first = updates[0]!.evidence;
    expect(first).toMatchObject({
      kind: "replacement",
      path: "/repo/src/first.ts",
      extent: "unknown",
      origin: "result",
      effectClaim: "provider-reported",
    });
    if (first.kind !== "replacement") throw new Error("expected a replacement");
    if (first.before.state !== "present" || first.after.state !== "present") {
      throw new Error("expected both sides present");
    }
    expect(bodyText(first.before.body.id)).toBe("a\nb\n");
    expect(bodyText(first.after.body.id)).toBe("a\nc\n");
    expect(updates[1]!.evidence).toMatchObject({ path: "/repo/src/second.ts" });
    expect(updates[4]!.evidence).toMatchObject({
      kind: "patch",
      path: "/repo/src/patched.ts",
      effectClaim: "provider-reported",
    });

    // The legacy aggregated diff the transcript carries is unchanged.
    const part = toolPart(state, "multi-1");
    expect(part?.toolDiff?.filePath).toBeUndefined();
    expect(part?.toolDiff).toMatchObject({ additions: 4, deletions: 4 });
  });

  test("a content update revises the same blocks instead of adding to them", () => {
    const state = runningState("evidence-revise");
    send(state, {
      sessionUpdate: "tool_call",
      toolCallId: "edit-1",
      title: "Edit",
      kind: "edit",
      status: "in_progress",
      content: [{ type: "diff", path: "/repo/a.ts", oldText: "1\n", newText: "2\n" }],
    });
    send(state, {
      sessionUpdate: "tool_call_update",
      toolCallId: "edit-1",
      content: [{ type: "diff", path: "/repo/a.ts", oldText: "1\n", newText: "3\n" }],
    });
    send(state, { sessionUpdate: "tool_call_update", toolCallId: "edit-1", status: "completed" });
    send(state, {
      sessionUpdate: "tool_call_update",
      toolCallId: "edit-1",
      content: [{ type: "diff", path: "/repo/a.ts", oldText: "1\n", newText: "4\n" }],
    });

    const calls = toolFrames("edit-1");
    const blocks = calls.flatMap((frame) => replaces(frame));
    const proposals = blocks.filter(
      (update) => update.evidenceKey === "proposal:diff:/repo/a.ts:0",
    );
    const results = blocks.filter((update) => update.evidenceKey === "diff:/repo/a.ts:0");
    expect(proposals).toHaveLength(2);
    expect(proposals[0]!.evidence).toMatchObject({ origin: "input", effectClaim: "proposal" });
    expect(proposals[1]!.revisionKey).not.toBe(proposals[0]!.revisionKey);
    expect(proposals[1]!.replacesRevisionKey).toBe(proposals[0]!.revisionKey);

    expect(results).toHaveLength(2);
    expect(results[0]!.evidence).toMatchObject({
      origin: "result",
      effectClaim: "provider-reported",
    });
    const after = (update: (typeof results)[number]) =>
      update.evidence.kind === "replacement" && update.evidence.after.state === "present"
        ? bodyText(update.evidence.after.body.id)
        : undefined;
    // The completion carried no content: the result is the latest proposal.
    expect(after(results[0]!)).toBe("3\n");
    expect(after(results[1]!)).toBe("4\n");
    expect(results[1]!.replacesRevisionKey).toBe(results[0]!.revisionKey);
    // One block per file at every point: never a second key for the same file.
    expect(new Set(blocks.map((update) => update.evidenceKey)).size).toBe(2);
  });

  test("late naming re-classifies the same operation", () => {
    const state = runningState("evidence-late");
    send(state, { sessionUpdate: "tool_call", toolCallId: "grok-1", title: "Working" });
    send(state, {
      sessionUpdate: "tool_call_update",
      toolCallId: "grok-1",
      status: "in_progress",
      _meta: { "x.ai/tool": { name: "run_terminal_cmd" } },
      rawInput: { command: "sed -i s/a/b/ notes.txt" },
    });
    send(state, { sessionUpdate: "tool_call_update", toolCallId: "grok-1", status: "completed" });

    const calls = toolFrames("grok-1");
    expect(calls.map((frame) => [frame.event.toolKind, frame.event.phase])).toEqual([
      ["other", "running"],
      ["shell", "running"],
      ["shell", "succeeded"],
    ]);
    expect(new Set(calls.map((frame) => frame.source.callId))).toEqual(new Set(["grok-1"]));
    expect(calls.every((frame) => frame.source.attemptId === undefined)).toBe(true);
    expect(new Set(calls.map((frame) => frame.bindingId)).size).toBe(1);
  });

  test("a null or omitted oldText is an established absence", () => {
    const state = runningState("evidence-new-file");
    send(state, {
      sessionUpdate: "tool_call",
      toolCallId: "write-1",
      title: "Write",
      _meta: { "x.ai/tool": { name: "write" } },
      status: "completed",
      content: [
        { type: "diff", path: "/repo/new.ts", oldText: null, newText: "export {};\n" },
        { type: "diff", path: "/repo/other.ts", newText: "x\n" },
        { type: "diff", path: "/repo/odd.ts", oldText: 7, newText: "y\n" },
      ],
    });
    const [frame] = toolFrames("write-1");
    expect(frame!.event.toolKind).toBe("file-write");
    const [created, omitted, malformed] = replaces(frame!).map((update) => update.evidence);
    expect(created).toMatchObject({ before: { state: "absent" }, after: { state: "present" } });
    expect(omitted).toMatchObject({ before: { state: "absent" } });
    expect(malformed).toMatchObject({ before: { state: "unknown" } });
  });

  test("a repeated update spools no duplicate frame", () => {
    const state = runningState("evidence-dedupe");
    const update = {
      sessionUpdate: "tool_call",
      toolCallId: "read-1",
      title: "Read",
      kind: "read",
      status: "in_progress",
    };
    send(state, update);
    send(state, { sessionUpdate: "tool_call_update", toolCallId: "read-1", title: "Read" });
    send(state, { sessionUpdate: "tool_call_update", toolCallId: "read-1", status: "in_progress" });
    expect(toolFrames("read-1")).toHaveLength(1);
    send(state, { sessionUpdate: "tool_call_update", toolCallId: "read-1", status: "completed" });
    expect(toolFrames("read-1").map((frame) => frame.event.phase)).toEqual([
      "running",
      "succeeded",
    ]);
  });

  test("a persisted spool re-issues unacknowledged frames under the same ids", async () => {
    const directory = await temporaryDirectory();
    const persisted = new ChangeEvidenceSpool({ directory });
    configureChangeEvidence({ spool: persisted });
    const state = runningState("evidence-persist");
    send(state, {
      sessionUpdate: "tool_call",
      toolCallId: "edit-p",
      kind: "edit",
      status: "completed",
      content: [{ type: "diff", path: "/repo/p.ts", oldText: "a\n", newText: "b\n" }],
    });
    const before = frames(persisted).map((frame) => frame.frameId);
    expect(before).toHaveLength(1);
    // Persistence is asynchronous; settle it as a clean shutdown would.
    await persisted.flush();

    const restored = new ChangeEvidenceSpool({ directory });
    expect(frames(restored).map((frame) => frame.frameId)).toEqual(before);
    const [restoredFrame] = frames(restored);
    const block = restoredFrame!.event.kind === "tool" ? restoredFrame!.event.evidence[0] : null;
    if (block?.kind !== "replace" || block.evidence.kind !== "replacement") {
      throw new Error("expected a replacement");
    }
    if (block.evidence.after.state !== "present") throw new Error("expected after content");
    expect(restored.readBody(block.evidence.after.body.id)).not.toBeNull();
  });

  test("approval waits and refusals reach the call's lifecycle", () => {
    const state = runningState("evidence-approval");
    // A request may name a call before the agent announces it.
    recordAcpToolApproval(state, "deny-1", "denied");
    send(state, { sessionUpdate: "tool_call", toolCallId: "deny-1", kind: "edit" });
    send(state, { sessionUpdate: "tool_call", toolCallId: "ask-1", kind: "edit" });
    recordAcpToolApproval(state, "ask-1", "awaiting");
    recordAcpToolApproval(state, "ask-1", "allowed");

    expect(toolFrames("deny-1").map((frame) => frame.event)).toEqual([
      expect.objectContaining({ phase: "denied", executionOccurrence: "did-not-run" }),
    ]);
    expect(toolFrames("ask-1").map((frame) => frame.event.phase)).toEqual([
      "running",
      "awaiting-approval",
      "running",
    ]);
    expect(toolFrames("ask-1").map((frame) => frame.event.executionOccurrence)).toEqual([
      "unknown",
      "not-started",
      "not-started",
    ]);
    send(state, { sessionUpdate: "tool_call_update", toolCallId: "ask-1", status: "in_progress" });
    expect(toolFrames("ask-1").at(-1)!.event).toMatchObject({
      phase: "running",
      executionOccurrence: "started",
    });
  });

  test("turn frames bracket the turn and settle calls it left open", () => {
    const state = runningState("evidence-turn");
    beginAcpTurnEvidence(state, "request-1");
    send(state, {
      sessionUpdate: "tool_call",
      toolCallId: "hang-1",
      kind: "edit",
      status: "in_progress",
    });
    reconcileStaleToolParts(state);
    endAcpTurnEvidence(state, "cancelled");

    const turnFrames = frames().filter((frame) => frame.event.kind === "turn");
    expect(turnFrames.map((frame) => [frame.source.turnId, frame.event])).toEqual([
      ["request-1", { kind: "turn", phase: "running", writerLiveness: "may-write" }],
      ["request-1", { kind: "turn", phase: "cancelled", writerLiveness: "quiescent" }],
    ]);
    expect(toolFrames("hang-1").map((frame) => frame.event.phase)).toEqual([
      "running",
      "cancelled",
    ]);
    expect(toolFrames("hang-1").every((frame) => frame.source.turnId === "request-1")).toBe(true);
  });

  test("an id reused by a later turn becomes a separate attempt", () => {
    const state = runningState("evidence-reuse");
    beginAcpTurnEvidence(state, "turn-a");
    send(state, {
      sessionUpdate: "tool_call",
      toolCallId: "call_0",
      title: "First",
      kind: "read",
      status: "completed",
    });
    endAcpTurnEvidence(state, "succeeded");
    state.messages.push({
      id: "evidence-reuse-user-2",
      role: "user",
      content: "again",
      parts: [],
      createdAt: new Date().toISOString(),
    });
    beginAcpTurnEvidence(state, "turn-b");
    send(state, {
      sessionUpdate: "tool_call",
      toolCallId: "call_0",
      title: "Second",
      kind: "read",
      status: "in_progress",
    });

    const calls = toolFrames("call_0");
    expect(calls.map((frame) => frame.source.attemptId)).toEqual([undefined, "reuse:turn-b"]);
  });

  test("a shell call reports the probe's observation and keeps the legacy badge", async () => {
    const observation: ProbeObservation = {
      change: {
        additions: 2,
        deletions: 1,
        files: [{ path: "notes.txt", additions: 2, deletions: 1 }],
      },
      boundary: { before: "late-start", after: "after-terminal" },
      overlap: "none-observed",
      omittedReasons: [],
    };
    const probe: CommandChangeProbe = {
      begin: async () => {},
      note: async () => {},
      endObservation: async () => observation,
      discard: () => {},
      prime: async () => {},
    };
    configureCommandChanges({ probe, journalDirectory: null });
    const state = runningState("evidence-shell");
    beginAcpTurnEvidence(state, "turn-shell");
    send(state, { sessionUpdate: "tool_call", toolCallId: "sh-1", title: "Run" });
    // Named only by the update that also completes it: the window opens and
    // closes at once on the probe's older baseline.
    send(state, {
      sessionUpdate: "tool_call_update",
      toolCallId: "sh-1",
      kind: "execute",
      status: "completed",
    });
    await settle();

    const reports = entries().flatMap((entry) =>
      entry.type === "observation" ? [entry.report as WorkspaceObservationReport] : [],
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      source: { conversationId: state.id, callId: "sh-1", turnId: "turn-shell" },
      boundary: { before: "late-start", after: "after-terminal" },
      overlap: "none-observed",
      outcome: { kind: "measured", additions: 2, deletions: 1 },
    });
    expect(toolPart(state, "sh-1")?.commandChanges).toMatchObject({
      additions: 2,
      deletions: 1,
      approximate: true,
    });
    expect(observation.change?.approximate).toBeUndefined();
  });
});

describe("ACP change capabilities", () => {
  test("declare what the bridge establishes", () => {
    expect(
      acpChangeCapabilities(GROK_RUNTIME, { measurementEnabled: true, executor: "host-worker" }),
    ).toEqual({
      resolution: "resolved",
      beforeTool: "observed-after-start",
      afterTool: "observed",
      beforeTurn: "controlled-dispatch",
      afterTurn: "terminal-observed",
      historicalCallIdentity: "partial",
      fileEvidence: { resolution: "confirmed", kinds: ["replacement", "patch"] },
      turnDiff: "absent",
      captureExecutor: "host-worker",
      captureAvailability: "ready",
      backgroundCompletion: "launch-only",
    });
    expect(
      acpChangeCapabilities(genericAcpRuntime("cursor"), {
        measurementEnabled: false,
        executor: "unknown",
      }),
    ).toMatchObject({ captureAvailability: "unavailable", backgroundCompletion: "unknown" });
  });

  test("name the capture executor only from a launch signal", () => {
    expect(acpCaptureExecutor({ DEVCONTAINER: "true", ACP_STATE_DIR: "/tmp/x" })).toBe(
      "container-worker",
    );
    expect(acpCaptureExecutor({ ACP_STATE_DIR: "/data/acp" })).toBe("host-worker");
    expect(acpCaptureExecutor({})).toBe("unknown");
  });
});

describe("change evidence routes", () => {
  test("serve frames and bodies, and release them on acknowledgment", async () => {
    const { base, headers } = await spawnBridge({ env: { DEVCONTAINER: undefined } });
    expect((await nativeFetch(`${base}/change-evidence`)).status).toBe(401);

    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-evidence:tab-multi" }),
    }).then((response) => response.json())) as { id: string };
    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "MULTIDIFF: edit two files", requestId: "req-multi" }),
    });

    const page = await waitFor(
      async () =>
        nativeFetch(`${base}/change-evidence`, { headers }).then(
          (response) => response.json() as Promise<ChangeEvidenceReadResponse>,
        ),
      (value) =>
        value.entries.some(
          (entry) =>
            entry.type === "frame" &&
            entry.frame.event.kind === "turn" &&
            entry.frame.event.phase !== "running",
        ),
    );
    expect(page.capabilities).toHaveLength(1);
    expect(page.capabilities[0]).toMatchObject({
      captureAvailability: "unavailable",
      captureExecutor: "host-worker",
    });
    const tool = page.entries.find(
      (entry) => entry.type === "frame" && entry.frame.source.callId === "multi-1",
    );
    if (tool?.type !== "frame" || tool.frame.event.kind !== "tool") {
      throw new Error("expected the multi-diff tool frame");
    }
    expect(tool.frame.source.conversationId).toBe(created.id);
    expect(tool.frame.source.turnId).toBe("req-multi");
    const blocks = tool.frame.event.evidence.flatMap((update) =>
      update.kind === "replace" ? [update.evidence] : [],
    );
    expect(blocks.map((block) => ("path" in block ? block.path : undefined))).toEqual([
      "src/first.ts",
      "src/second.ts",
    ]);
    const second = blocks[1]!;
    if (second.kind !== "replacement" || second.after.state !== "present") {
      throw new Error("expected after content");
    }
    const body = (await nativeFetch(
      `${base}/change-evidence/body?id=${encodeURIComponent(second.after.body.id)}`,
      { headers },
    ).then((response) => response.json())) as { state: string; base64?: string };
    expect(body.state).toBe("available");
    expect(Buffer.from(body.base64!, "base64").toString("utf8")).toBe("after\nkeep");
    const missing = (await nativeFetch(`${base}/change-evidence/body?id=sha256:nope`, {
      headers,
    }).then((response) => response.json())) as { state: string };
    expect(missing.state).toBe("missing");

    const invalid = await nativeFetch(`${base}/change-evidence/ack`, {
      method: "POST",
      headers,
      body: JSON.stringify({ upTo: "all" }),
    });
    expect(invalid.status).toBe(400);
    const ack = (await nativeFetch(`${base}/change-evidence/ack`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        runtimeEpoch: page.runtimeEpoch,
        upTo: page.nextCursor,
        retainedBodyIds: [second.after.body.id],
        unavailableBodyIds: [],
      }),
    }).then((response) => response.json())) as { ok: boolean; released: number };
    expect(ack).toEqual({ ok: true, released: page.entries.length });
    const after = (await nativeFetch(`${base}/change-evidence`, { headers }).then((response) =>
      response.json(),
    )) as ChangeEvidenceReadResponse;
    expect(after.entries).toEqual([]);
    const released = (await nativeFetch(
      `${base}/change-evidence/body?id=${encodeURIComponent(second.after.body.id)}`,
      { headers },
    ).then((response) => response.json())) as { state: string };
    expect(released.state).toBe("missing");
  });
});
