/**
 * Cursor's change-evidence adapter: native tool payloads in, canonical frames
 * out, and the spool routes the backend pulls them through.
 *
 * Fixtures are the SDK's own tool-call shapes (`@cursor/sdk` 1.0.37
 * `EditSuccess`, `WriteSuccess`, `DeleteSuccess`, `ShellArgs`), delivered the
 * way the interaction stream delivers them.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import type {
  ProviderEvidence,
  ProviderEvidenceFrame,
  WorkspaceObservationReport,
} from "@orkestrator/protocol/change-evidence";
import { ChangeEvidenceSpool } from "@orkestrator/protocol/node/change-tracking/evidence-spool";
import type { ProbeObservation } from "@orkestrator/protocol/node/workspace-change-probe";
import { newSessionState } from "./agent-session.js";
import {
  CONTAINER_STATE_DIRECTORY,
  cursorChangeCapabilities,
  cursorPatchFormat,
  evidencePath,
  resolveCaptureExecutor,
  trackTurnEvidence,
  useChangeEvidenceForTests,
} from "./change-evidence.js";
import {
  trackCommandChanges,
  useCommandChangeProbeForTests,
  type CommandChangeProbe,
} from "./command-changes.js";
import { workingDirectory } from "./config.js";
import { dispatchPrompt } from "./prompt.js";
import type { BridgeToolPart, SessionState } from "./state.js";
import { fakeAgent } from "./testing/fake-agent.js";
import { startRouterHarness } from "./testing/router-harness.js";
import { applyInteractionUpdate } from "./translate.js";

/** What Cursor's own diff builder writes: `+ line` rows, no headers or ranges. */
const CURSOR_DIFF = "  const a = 1;\n- const b = 2;\n+ const b = 3;\n+ const c = 4;";
const UNIFIED_DIFF = [
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,3 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  "",
].join("\n");

const file = (name: string) => path.join(workingDirectory, name);

const editCall = (filePath: string, value?: Record<string, unknown>) => ({
  type: "edit",
  args: { path: filePath },
  ...(value ? { result: { status: "success", value } } : {}),
});

const writeCall = (filePath: string, fileText: string, value?: Record<string, unknown>) => ({
  type: "write",
  args: { path: filePath, fileText },
  ...(value ? { result: { status: "success", value: { path: filePath, ...value } } } : {}),
});

const deleteCall = (filePath: string, value?: Record<string, unknown>) => ({
  type: "delete",
  args: { path: filePath },
  ...(value ? { result: { status: "success", value } } : {}),
});

const shellCall = (command: string, exitCode?: number) => ({
  type: "shell",
  args: { command },
  ...(exitCode === undefined
    ? {}
    : {
        result: {
          status: "success",
          value: { exitCode, signal: "", stdout: "", stderr: "", executionTime: 1 },
        },
      }),
});

const started = (callId: string, toolCall: object) => ({
  type: "tool-call-started",
  callId,
  toolCall,
});
const completed = (callId: string, toolCall: object) => ({
  type: "tool-call-completed",
  callId,
  toolCall,
});

let spool: ChangeEvidenceSpool;
let restoreEvidence: () => void;

beforeEach(() => {
  spool = new ChangeEvidenceSpool();
  restoreEvidence = useChangeEvidenceForTests(spool, "host-worker");
});

afterEach(() => {
  restoreEvidence();
});

function frames(): ProviderEvidenceFrame[] {
  return spool
    .read(0, 1_024)
    .entries.flatMap((entry) => (entry.type === "frame" ? [entry.frame] : []));
}

function observations(): WorkspaceObservationReport[] {
  return spool
    .read(0, 1_024)
    .entries.flatMap((entry) => (entry.type === "observation" ? [entry.report] : []));
}

function toolFrames(callId?: string) {
  return frames().filter(
    (frame) => frame.event.kind === "tool" && (!callId || frame.source.callId === callId),
  );
}

function evidenceOf(frame: ProviderEvidenceFrame | undefined): ProviderEvidence[] {
  if (!frame || frame.event.kind !== "tool") return [];
  return frame.event.evidence.flatMap((update) =>
    update.kind === "replace" ? [update.evidence] : [],
  );
}

function bodyText(evidence: ProviderEvidence | undefined): string | undefined {
  const ref =
    evidence?.kind === "patch"
      ? evidence.body
      : evidence?.kind === "replacement" && evidence.after.state === "present"
        ? evidence.after.body
        : undefined;
  const bytes = ref ? spool.readBody(ref.id) : null;
  return bytes ? new TextDecoder().decode(bytes) : undefined;
}

describe("file tools", () => {
  test("an edit reports its counts and its diff as independent evidence", () => {
    const turn = trackTurnEvidence("session-1", { turnId: "turn-1", mode: "live" });
    turn.observe(started("e1", editCall(file("src/a.ts"))));
    turn.observe(
      completed(
        "e1",
        editCall(file("src/a.ts"), { linesAdded: 2, linesRemoved: 1, diffString: CURSOR_DIFF }),
      ),
    );

    const [running, settled] = toolFrames("e1");
    expect(running?.event).toMatchObject({
      kind: "tool",
      toolKind: "file-edit",
      phase: "running",
      executionOccurrence: "started",
      evidence: [],
    });
    expect(settled?.event).toMatchObject({
      toolKind: "file-edit",
      phase: "succeeded",
      executionOccurrence: "started",
    });
    expect(settled?.source).toMatchObject({
      conversationId: "session-1",
      callId: "e1",
      turnId: "turn-1",
      mode: "live",
    });
    const [counts, patch] = evidenceOf(settled);
    expect(counts).toEqual({
      kind: "reported-counts",
      path: "src/a.ts",
      additions: 2,
      deletions: 1,
      scope: "file",
      effectClaim: "provider-reported",
    });
    // Cursor's diff string is not a unified patch, so it is not labelled one.
    expect(patch).toMatchObject({
      kind: "patch",
      path: "src/a.ts",
      format: "opaque",
      effectClaim: "provider-reported",
    });
    expect(bodyText(patch)).toBe(CURSOR_DIFF);
  });

  test("either half of an edit's evidence stands alone", () => {
    const turn = trackTurnEvidence("session-1", { mode: "live" });
    turn.observe(completed("counts", editCall(file("a.ts"), { linesAdded: 4 })));
    turn.observe(completed("diff", editCall(file("a.ts"), { diffString: UNIFIED_DIFF })));

    expect(evidenceOf(toolFrames("counts")[0])).toEqual([
      {
        kind: "reported-counts",
        path: "a.ts",
        additions: 4,
        deletions: null,
        scope: "file",
        effectClaim: "provider-reported",
      },
    ]);
    const diffOnly = evidenceOf(toolFrames("diff")[0]);
    expect(diffOnly.map((evidence) => evidence.kind)).toEqual(["patch"]);
    expect(diffOnly[0]).toMatchObject({ format: "git_unified" });
  });

  test("a write reports content lines, never additions, and an unknown before-image", () => {
    const turn = trackTurnEvidence("session-1", { mode: "live" });
    turn.observe(started("w1", writeCall(file("new.ts"), "one\ntwo\n")));
    turn.observe(
      completed(
        "w1",
        writeCall(file("new.ts"), "one\ntwo\n", {
          linesCreated: 2,
          fileSize: 8,
          fileContentAfterWrite: "one\ntwo\n",
        }),
      ),
    );

    const settled = toolFrames("w1")[1];
    expect(settled?.event).toMatchObject({ toolKind: "file-write", phase: "succeeded" });
    const [counts, replacement] = evidenceOf(settled);
    expect(counts).toEqual({
      kind: "reported-counts",
      path: "new.ts",
      additions: null,
      deletions: null,
      contentLines: 2,
      scope: "file",
      effectClaim: "provider-reported",
    });
    expect(replacement).toMatchObject({
      kind: "replacement",
      path: "new.ts",
      before: { state: "unknown" },
      after: { state: "present" },
      extent: "whole-file",
      origin: "result",
      effectClaim: "provider-reported",
    });
    expect(bodyText(replacement)).toBe("one\ntwo\n");
  });

  test("a write without the returned content keeps its input as the after-image", () => {
    const turn = trackTurnEvidence("session-1", { mode: "live" });
    turn.observe(
      completed("w2", writeCall(file("b.ts"), "body\n", { linesCreated: 1, fileSize: 5 })),
    );

    const replacement = evidenceOf(toolFrames("w2")[0])[1];
    expect(replacement).toMatchObject({ kind: "replacement", origin: "input" });
    expect(bodyText(replacement)).toBe("body\n");
  });

  test("a delete reports the path operation even without counts", () => {
    const turn = trackTurnEvidence("session-1", { mode: "live" });
    turn.observe(started("d1", deleteCall(file("old.ts"))));
    turn.observe(completed("d1", deleteCall(file("old.ts"), { fileSize: 12 })));

    expect(evidenceOf(toolFrames("d1")[1])).toEqual([
      {
        kind: "path-operation",
        path: "old.ts",
        operation: "delete",
        effectClaim: "provider-reported",
      },
    ]);
  });

  test("a failed call carries no evidence of an effect", () => {
    const turn = trackTurnEvidence("session-1", { mode: "live" });
    const failed = {
      ...editCall(file("a.ts")),
      result: { status: "error", error: { message: "no match" } },
    };
    turn.observe(started("e1", editCall(file("a.ts"))));
    turn.observe(completed("e1", failed));
    turn.observe(completed("e2", failed));

    expect(toolFrames("e1")[1]?.event).toMatchObject({
      phase: "failed",
      executionOccurrence: "started",
      evidence: [],
    });
    // No start was seen, so whether it ran is not known.
    expect(toolFrames("e2")[0]?.event).toMatchObject({
      phase: "failed",
      executionOccurrence: "unknown",
    });
  });

  test("tools that cannot change files produce no frames", () => {
    const turn = trackTurnEvidence("session-1", { mode: "live" });
    turn.observe(started("r1", { type: "read", args: { path: "a.ts" } }));
    turn.observe({ type: "partial-tool-call", callId: "e1", toolCall: editCall("a.ts") });
    turn.observe(started("", editCall("a.ts")));
    turn.observe(null);
    turn.observe({ type: "tool-call-completed", callId: "x", toolCall: "garbage" });
    expect(frames()).toEqual([]);
  });

  test("a sub-agent's call names the launch call that owns it", () => {
    const turn = trackTurnEvidence("session-1", { mode: "live" });
    turn.observe({
      type: "tool-call-delta",
      callId: "task-1",
      taskUpdate: completed("child", editCall(file("a.ts"), { linesAdded: 1, linesRemoved: 0 })),
    });
    expect(toolFrames("child")[0]?.source.parentCallId).toBe("task-1");
  });
});

describe("lifecycle", () => {
  test("a re-reported event is one frame", () => {
    const turn = trackTurnEvidence("session-1", { mode: "live" });
    const done = completed("e1", editCall(file("a.ts"), { linesAdded: 1, linesRemoved: 1 }));
    turn.observe(started("e1", editCall(file("a.ts"))));
    turn.observe(started("e1", editCall(file("a.ts"))));
    turn.observe(done);
    turn.observe(done);
    expect(
      toolFrames("e1").map((frame) => frame.event.kind === "tool" && frame.event.phase),
    ).toEqual(["running", "succeeded"]);
  });

  test("turn frames bracket the turn and a cancelled turn cancels its open calls", () => {
    const turn = trackTurnEvidence("session-1", { turnId: "turn-1", mode: "live" });
    turn.start();
    turn.observe(started("s1", shellCall("sleep 100")));
    turn.end({ phase: "cancelled", terminal: true });
    turn.end({ phase: "unknown", terminal: false });

    const events = frames().map((frame) => frame.event);
    expect(events).toEqual([
      { kind: "turn", phase: "running", writerLiveness: "may-write" },
      expect.objectContaining({ kind: "tool", phase: "running", toolKind: "shell" }),
      expect.objectContaining({ kind: "tool", phase: "cancelled", executionOccurrence: "started" }),
      { kind: "turn", phase: "cancelled", writerLiveness: "quiescent" },
    ]);
  });

  test("a turn that ended without a terminal result leaves its calls and writers unknown", () => {
    const turn = trackTurnEvidence("session-1", { turnId: "turn-2", mode: "live" });
    turn.observe(started("s1", shellCall("sleep 100")));
    turn.end({ phase: "failed", terminal: false });

    const events = frames().map((frame) => frame.event);
    expect(events[1]).toMatchObject({ kind: "tool", phase: "unknown" });
    expect(events[2]).toEqual({ kind: "turn", phase: "failed", writerLiveness: "unknown" });
  });

  test("a background sub-agent is launch-only: its end is unknown", () => {
    const turn = trackTurnEvidence("session-1", { turnId: "turn-3", mode: "live" });
    turn.observe(
      completed("task-1", {
        type: "task",
        args: { description: "x" },
        result: { status: "success", value: { isBackground: true, agentId: "child-agent" } },
      }),
    );
    turn.end({ phase: "succeeded", terminal: true });

    const events = frames().map((frame) => frame.event);
    expect(events).toEqual([
      expect.objectContaining({
        kind: "background-task",
        taskId: "child-agent",
        parentCallId: "task-1",
        phase: "running",
      }),
      expect.objectContaining({
        kind: "background-task",
        phase: "unknown",
        writerLiveness: "unknown",
      }),
      { kind: "turn", phase: "succeeded", writerLiveness: "unknown" },
    ]);
  });

  test("a shell call that exits non-zero failed", () => {
    const turn = trackTurnEvidence("session-1", { mode: "live" });
    turn.observe(completed("s1", shellCall("false", 1)));
    expect(toolFrames("s1")[0]?.event).toMatchObject({
      toolKind: "shell",
      phase: "failed",
      executionOccurrence: "started",
    });
  });
});

describe("shell observations", () => {
  const CHANGE = {
    additions: 3,
    deletions: 1,
    files: [{ path: "src/a.ts", status: "M" as const, additions: 3, deletions: 1 }],
  };
  let observation: ProbeObservation | undefined;
  let restoreProbe: () => void;

  beforeEach(() => {
    observation = undefined;
    const probe: CommandChangeProbe = {
      prime: async () => undefined,
      begin: async () => undefined,
      note: async () => undefined,
      endObservation: async () => observation,
      discard: () => undefined,
    };
    restoreProbe = useCommandChangeProbeForTests(probe);
  });

  afterEach(() => restoreProbe());

  async function runShell(state: SessionState, mode: "live" | "reconciliation" = "live") {
    const turn = trackTurnEvidence(state.id, { turnId: "turn-1", mode });
    const tracker = trackCommandChanges(state, turn);
    for (const update of [
      started("c1", shellCall("sed -i x a")),
      completed("c1", shellCall("x", 0)),
    ]) {
      turn.observe(update);
      tracker.observe(update);
      applyInteractionUpdate(state, update);
    }
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  function card(state: SessionState): BridgeToolPart | undefined {
    for (const message of state.messages) {
      for (const part of message.parts) {
        if (part.type === "tool-invocation" && part.toolUseId === "c1") return part;
      }
    }
    return undefined;
  }

  test("reports the window and keeps the legacy badge identical", async () => {
    observation = {
      change: structuredClone(CHANGE),
      boundary: { before: "prior-observation", after: "after-terminal" },
      overlap: "none-observed",
      omittedReasons: [],
    };
    const state = newSessionState();
    await runShell(state);

    expect(card(state)?.commandChanges).toEqual(CHANGE);
    const [report] = observations();
    expect(report).toMatchObject({
      source: { conversationId: state.id, callId: "c1", turnId: "turn-1" },
      executor: "host-worker",
      boundary: { before: "prior-observation", after: "after-terminal" },
      overlap: "none-observed",
      outcome: { kind: "measured", additions: 3, deletions: 1, changedFiles: 1 },
    });
  });

  test("a late start or an overlap marks the legacy badge approximate, as `end` did", async () => {
    observation = {
      change: structuredClone(CHANGE),
      boundary: { before: "late-start", after: "after-terminal" },
      overlap: "known-overlap",
      omittedReasons: [],
    };
    const state = newSessionState();
    await runShell(state);

    expect(card(state)?.commandChanges).toEqual({ ...CHANGE, approximate: true });
    expect(observations()[0]).toMatchObject({
      boundary: { before: "late-start" },
      overlap: "known-overlap",
    });
  });

  test("an unmeasurable window is reported unavailable and leaves no badge", async () => {
    observation = {
      boundary: { before: "prior-observation", after: "unknown" },
      overlap: "none-observed",
      omittedReasons: [],
      unavailableReason: "probe-disabled",
    };
    const state = newSessionState();
    await runShell(state);

    expect(card(state)?.commandChanges).toBeUndefined();
    expect(observations()[0]?.outcome).toEqual({ kind: "unavailable", reason: "probe-disabled" });
  });

  test("no observation is reported under an executor the bridge cannot name", async () => {
    restoreEvidence();
    spool = new ChangeEvidenceSpool();
    restoreEvidence = useChangeEvidenceForTests(spool, "unknown");
    observation = {
      change: structuredClone(CHANGE),
      boundary: { before: "prior-observation", after: "after-terminal" },
      overlap: "none-observed",
      omittedReasons: [],
    };
    const state = newSessionState();
    await runShell(state);

    expect(card(state)?.commandChanges).toEqual(CHANGE);
    expect(observations()).toEqual([]);
    expect(spool.read(0).capabilities).toHaveLength(1);
    expect(spool.read(0).capabilities[0]).toMatchObject({
      captureExecutor: "unknown",
      captureAvailability: "unknown",
      resolution: "partial",
    });
  });

  test("a re-adopted run is never given a workspace observation", async () => {
    observation = {
      change: structuredClone(CHANGE),
      boundary: { before: "prior-observation", after: "after-terminal" },
      overlap: "none-observed",
      omittedReasons: [],
    };
    await runShell(newSessionState(), "reconciliation");
    expect(observations()).toEqual([]);
    expect(toolFrames("c1").every((frame) => frame.source.mode === "reconciliation")).toBe(true);
  });
});

describe("a dispatched turn", () => {
  test("frames name the bridge session, the card's call id and the request id", async () => {
    const state = newSessionState();
    state.status = "running";
    const agent = fakeAgent({
      updates: [
        started("edit-1", editCall(file("a.ts"))),
        completed("edit-1", editCall(file("a.ts"), { linesAdded: 1, linesRemoved: 1 })),
      ],
    });

    const handle = await dispatchPrompt(state, agent, {
      prompt: "go",
      images: [],
      requestId: "request-1",
    });
    await handle.completion;

    const card = state.messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === "tool-invocation");
    expect(card?.type === "tool-invocation" && card.toolUseId).toBe("edit-1");
    expect(card?.type === "tool-invocation" && card.toolDiff).toMatchObject({
      additions: 1,
      deletions: 1,
    });
    const events = frames().map((frame) => [
      frame.source.conversationId,
      frame.source.turnId,
      frame.source.callId,
      frame.event.kind,
      "phase" in frame.event ? frame.event.phase : undefined,
    ]);
    expect(events).toEqual([
      [state.id, "request-1", undefined, "turn", "running"],
      [state.id, "request-1", "edit-1", "tool", "running"],
      [state.id, "request-1", "edit-1", "tool", "succeeded"],
      [state.id, "request-1", undefined, "turn", "succeeded"],
    ]);
  });

  test("a failed run ends its turn failed", async () => {
    const state = newSessionState();
    state.status = "running";
    const agent = fakeAgent({ status: "error", errorMessage: "boom" });
    const handle = await dispatchPrompt(state, agent, {
      prompt: "go",
      images: [],
      requestId: "request-2",
    });
    await handle.completion;

    expect(frames().at(-1)?.event).toEqual({
      kind: "turn",
      phase: "failed",
      writerLiveness: "quiescent",
    });
  });
});

describe("capabilities", () => {
  test("declares what Cursor can establish", () => {
    expect(cursorChangeCapabilities("host-worker")).toEqual({
      resolution: "resolved",
      beforeTurn: "controlled-dispatch",
      afterTurn: "terminal-observed",
      beforeTool: "observed-after-start",
      afterTool: "observed",
      historicalCallIdentity: "partial",
      fileEvidence: { resolution: "confirmed", kinds: ["patch", "reported-counts", "whole-file"] },
      turnDiff: "absent",
      captureExecutor: "host-worker",
      captureAvailability: "ready",
      backgroundCompletion: "launch-only",
    });
  });

  test("names the executor only from a launcher's own state directory", () => {
    expect(resolveCaptureExecutor(CONTAINER_STATE_DIRECTORY)).toBe("container-worker");
    expect(
      resolveCaptureExecutor("/Users/me/Library/Application Support/x/cursor-bridge-state/env-1"),
    ).toBe("host-worker");
    expect(resolveCaptureExecutor("/tmp/elsewhere")).toBe("unknown");
    expect(resolveCaptureExecutor(null)).toBe("unknown");
  });

  test("labels only a complete, headed unified patch git_unified", () => {
    expect(cursorPatchFormat(UNIFIED_DIFF)).toBe("git_unified");
    expect(cursorPatchFormat(CURSOR_DIFF)).toBe("opaque");
    expect(cursorPatchFormat("@@ -1 +1 @@\n-a\n+b")).toBe("opaque");
    expect(cursorPatchFormat("--- a/x\n+++ b/x\n@@ -1,3 +1,1 @@\n-a\n")).toBe("opaque");
  });

  test("relativizes workspace paths and leaves outside paths alone", () => {
    expect(evidencePath(file("src/a.ts"))).toBe("src/a.ts");
    expect(evidencePath("src/b.ts")).toBe("src/b.ts");
    expect(evidencePath("/elsewhere/c.ts")).toBe("/elsewhere/c.ts");
    expect(evidencePath("  ")).toBeUndefined();
  });
});

describe("routes", () => {
  test("serve frames and bodies behind the bridge token and release only on ack", async () => {
    const harness = await startRouterHarness();
    try {
      const turn = trackTurnEvidence("session-1", { mode: "live" });
      turn.observe(
        completed(
          "e1",
          editCall(file("a.ts"), { linesAdded: 1, linesRemoved: 1, diffString: CURSOR_DIFF }),
        ),
      );

      const unauthorized = await harness.call("/change-evidence", {
        headers: { authorization: "Bearer wrong" },
      });
      expect(unauthorized.status).toBe(401);

      const read = await harness.call("/change-evidence?cursor=0");
      expect(read.status).toBe(200);
      const page = (await read.json()) as {
        runtimeEpoch: string;
        nextCursor: number;
        entries: Array<{ type: string; frame: ProviderEvidenceFrame }>;
        capabilities: Array<{ captureExecutor: string }>;
      };
      expect(page.entries).toHaveLength(1);
      expect(page.capabilities[0]?.captureExecutor).toBe("host-worker");
      const patch = evidenceOf(page.entries[0]!.frame).find(
        (evidence) => evidence.kind === "patch",
      );
      const bodyId = patch?.kind === "patch" ? patch.body.id : "";

      const body = (await (
        await harness.call(`/change-evidence/body?id=${encodeURIComponent(bodyId)}`)
      ).json()) as { state: string; base64: string };
      expect(body.state).toBe("available");
      expect(Buffer.from(body.base64, "base64").toString("utf8")).toBe(CURSOR_DIFF);

      const missing = await harness.call("/change-evidence/body?id=sha256%3Anope");
      expect(missing.status).toBe(200);
      expect(await missing.json()).toMatchObject({ state: "missing" });

      // A read is not an acknowledgment.
      expect(spool.stats().entries).toBe(1);

      const invalid = await harness.call("/change-evidence/ack", {
        method: "POST",
        body: JSON.stringify({ upTo: "all" }),
      });
      expect(invalid.status).toBe(400);

      const ack = await harness.call("/change-evidence/ack", {
        method: "POST",
        body: JSON.stringify({
          runtimeEpoch: page.runtimeEpoch,
          upTo: page.nextCursor,
          retainedBodyIds: [bodyId],
          unavailableBodyIds: [],
        }),
      });
      expect(await ack.json()).toEqual({ ok: true, released: 1 });
      expect(spool.stats()).toMatchObject({ entries: 0, bodies: 0 });
    } finally {
      await harness.close();
    }
  });
});
