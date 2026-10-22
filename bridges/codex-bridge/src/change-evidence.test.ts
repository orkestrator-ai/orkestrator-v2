import { describe, expect, test } from "bun:test";
import type {
  ProviderEvidenceFrame,
  ProviderEvidenceUpdate,
  WorkspaceObservationReport,
} from "@orkestrator/protocol/change-evidence";
import { ChangeEvidenceSpool } from "@orkestrator/protocol/node/change-tracking/evidence-spool";
import type {
  BeginOptions,
  ProbeObservation,
} from "@orkestrator/protocol/node/workspace-change-probe";
import type { MeasuredWorkspaceChange } from "@orkestrator/protocol/tool-diff";
import { adaptAppServerItem } from "./app-server/item-adapter.js";
import {
  CodexChangeEvidence,
  codexChangeCapabilities,
  codexChangeEvidenceDir,
  detectCaptureExecutor,
  legacyCommandChange,
  PATCH_PREVIEW_INTERVAL_MS,
} from "./change-evidence.js";
import type { EngineItem } from "./engine/types.js";
import type { CommandChangeProbe } from "./sessions/command-changes.js";
import { harness } from "./app-server-runtime-test-harness.js";

/** A native app-server item, adapted exactly as the reducer does. */
function native(raw: Record<string, unknown>): EngineItem {
  const { item } = adaptAppServerItem(raw);
  if (!item) throw new Error("fixture did not adapt");
  return item;
}

function setup(now = () => 0) {
  const spool = new ChangeEvidenceSpool();
  const evidence = new CodexChangeEvidence({ spool, executor: "host-worker", now });
  return { spool, evidence };
}

function frames(spool: ChangeEvidenceSpool): ProviderEvidenceFrame[] {
  return spool
    .read(0, 1_024)
    .entries.flatMap((entry) => (entry.type === "frame" ? [entry.frame] : []));
}

function observations(spool: ChangeEvidenceSpool): WorkspaceObservationReport[] {
  return spool
    .read(0, 1_024)
    .entries.flatMap((entry) => (entry.type === "observation" ? [entry.report] : []));
}

function updates(
  frame: ProviderEvidenceFrame,
): Extract<ProviderEvidenceUpdate, { kind: "replace" }>[] {
  const event = frame.event;
  if (event.kind !== "tool" && event.kind !== "turn-diff") return [];
  return event.evidence.filter(
    (update): update is Extract<ProviderEvidenceUpdate, { kind: "replace" }> =>
      update.kind === "replace",
  );
}

function body(spool: ChangeEvidenceSpool, update: ProviderEvidenceUpdate): string | undefined {
  if (update.kind !== "replace" || update.evidence.kind !== "patch") return undefined;
  const bytes = spool.readBody(update.evidence.body.id);
  return bytes ? new TextDecoder().decode(bytes) : undefined;
}

const source = { sessionIds: ["session-a"], turnId: "turn-1" };

/** Native `v2/FileUpdateChange` payloads, in the shapes app-server sends. */
const UPDATE = {
  path: "/w/src/a.ts",
  kind: { type: "update", move_path: null },
  diff: "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n",
};
const ADD = { path: "/w/src/b.ts", kind: { type: "add" }, diff: "export const b = true;\n" };
const MOVE = {
  path: "/w/src/old.ts",
  kind: { type: "update", move_path: "/w/src/new.ts" },
  diff: "@@ -1 +1 @@\n-x\n+y\n\n\nMoved to: /w/src/new.ts",
};

describe("Codex change evidence conformance", () => {
  test("declares only what the bridge establishes", () => {
    expect(detectCaptureExecutor((path) => path === "/.dockerenv")).toBe("container-worker");
    expect(detectCaptureExecutor(() => false)).toBe("host-worker");
    expect(codexChangeCapabilities("host-worker")).toMatchObject({
      beforeTool: "observed-after-start",
      afterTool: "observed",
      beforeTurn: "controlled-dispatch",
      afterTurn: "terminal-observed",
      historicalCallIdentity: "stable",
      fileEvidence: { resolution: "confirmed", kinds: ["patch"] },
      turnDiff: "reported",
      captureAvailability: "ready",
      backgroundCompletion: "unknown",
    });
    const { spool } = setup();
    expect(spool.read(0).capabilities).toHaveLength(1);
    expect(codexChangeEvidenceDir("/home/.codex", "/w")).toStartWith(
      "/home/.codex/orkestrator-bridge/change-evidence/",
    );
  });

  test("retains one patch per file, with its path, rename and payload", () => {
    const { spool, evidence } = setup();
    evidence.item(
      source,
      "completed",
      native({
        id: "call-1",
        type: "fileChange",
        status: "completed",
        changes: [UPDATE, ADD, MOVE],
      }),
    );

    const [frame] = frames(spool);
    expect(frame!.source).toMatchObject({
      conversationId: "session-a",
      callId: "call-1",
      turnId: "turn-1",
      mode: "live",
    });
    expect(frame!.event).toMatchObject({
      kind: "tool",
      toolKind: "file-edit",
      phase: "succeeded",
      executionOccurrence: "started",
    });
    const blocks = updates(frame!);
    expect(blocks.map((update) => update.evidenceKey)).toEqual([
      "file:0",
      "file:1",
      "path:1",
      "file:2",
      "path:2",
    ]);
    expect(blocks.map((update) => update.evidence)).toMatchObject([
      {
        kind: "patch",
        path: "/w/src/a.ts",
        format: "git_unified",
        effectClaim: "provider-reported",
      },
      // An add's payload is the file's content, not a diff.
      { kind: "patch", path: "/w/src/b.ts", format: "opaque", effectClaim: "provider-reported" },
      { kind: "path-operation", path: "/w/src/b.ts", operation: "add" },
      {
        kind: "patch",
        path: "/w/src/new.ts",
        previousPath: "/w/src/old.ts",
        format: "git_unified",
      },
      {
        kind: "path-operation",
        path: "/w/src/new.ts",
        previousPath: "/w/src/old.ts",
        operation: "rename",
      },
    ]);
    expect(body(spool, blocks[0]!)).toBe(UPDATE.diff);
    expect(body(spool, blocks[1]!)).toBe(ADD.diff);
    // app-server's rename note is not part of the hunks.
    expect(body(spool, blocks[3]!)).toBe("@@ -1 +1 @@\n-x\n+y\n");
  });

  test("an in-progress patch stays a proposal and completion is a separate reported block", () => {
    let clock = 0;
    const { spool, evidence } = setup(() => clock);
    const changes = [UPDATE];
    evidence.item(
      source,
      "started",
      native({ id: "p", type: "fileChange", status: "inProgress", changes }),
    );
    clock += PATCH_PREVIEW_INTERVAL_MS;
    evidence.item(
      source,
      "updated",
      native({ id: "p", type: "fileChange", status: "inProgress", changes }),
    );
    evidence.item(
      source,
      "completed",
      native({ id: "p", type: "fileChange", status: "completed", changes }),
    );

    const tool = frames(spool).filter((frame) => frame.event.kind === "tool");
    expect(tool.map((frame) => frame.event.kind === "tool" && frame.event.phase)).toEqual([
      "running",
      "proposed",
      "succeeded",
    ]);
    for (const frame of tool.slice(0, 2)) {
      expect(
        updates(frame).map((update) => [update.evidenceKey, update.evidence.effectClaim]),
      ).toEqual([["file:0:proposal", "proposal"]]);
    }
    const reported = updates(tool[2]!);
    expect(reported.map((update) => [update.evidenceKey, update.evidence.effectClaim])).toEqual([
      ["file:0", "provider-reported"],
    ]);
    // Never folded: the reported block does not replace the proposal.
    expect(reported[0]!.replacesRevisionKey).toBeUndefined();
  });

  test("streamed previews are rate limited; the terminal frame still carries the payload", () => {
    let clock = 0;
    const { spool, evidence } = setup(() => clock);
    for (let index = 0; index < 5; index += 1) {
      evidence.item(
        source,
        "updated",
        native({
          id: "p",
          type: "fileChange",
          status: "inProgress",
          changes: [{ ...UPDATE, diff: `@@ -1 +1 @@\n-a\n+b${index}\n` }],
        }),
      );
      clock += 10;
    }
    expect(frames(spool)).toHaveLength(1);
  });

  test("a declined patch is denied and did not run", () => {
    const { spool, evidence } = setup();
    evidence.item(
      source,
      "completed",
      native({ id: "d", type: "fileChange", status: "declined", changes: [UPDATE] }),
    );
    const [frame] = frames(spool);
    expect(frame!.event).toMatchObject({
      kind: "tool",
      phase: "denied",
      executionOccurrence: "did-not-run",
    });
    expect(updates(frame!)[0]!.evidence.effectClaim).toBe("proposal");
  });

  test("a change with no supplied diff is a path operation only", () => {
    const { spool, evidence } = setup();
    evidence.item(
      source,
      "completed",
      native({
        id: "old",
        type: "fileChange",
        status: "completed",
        changes: [{ path: "/w/a.ts", kind: { type: "delete" } }],
      }),
    );
    const [frame] = frames(spool);
    expect(frame!.event).toMatchObject({ toolKind: "file-delete" });
    expect(updates(frame!).map((update) => update.evidence)).toEqual([
      {
        kind: "path-operation",
        path: "/w/a.ts",
        operation: "delete",
        effectClaim: "provider-reported",
      },
    ]);
  });

  test("turn diff updates replace one another under one key", () => {
    const { spool, evidence } = setup();
    const first = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
    const second = `${first}diff --git a/c.ts b/c.ts\n--- /dev/null\n+++ b/c.ts\n@@ -0,0 +1 @@\n+c\n`;
    evidence.turnDiff(source, first);
    evidence.turnDiff(source, second);
    evidence.turnDiff(source, second);

    const turnDiffs = frames(spool).filter((frame) => frame.event.kind === "turn-diff");
    expect(turnDiffs).toHaveLength(2);
    const [a, b] = turnDiffs.map((frame) => updates(frame)[0]!);
    expect(new Set([a!.evidenceKey, b!.evidenceKey])).toEqual(new Set(["turn-diff"]));
    expect(a!.revisionKey).not.toBe(b!.revisionKey);
    expect(b!.replacesRevisionKey).toBe(a!.revisionKey);
    expect(turnDiffs[1]!.event).toMatchObject({ endpointMeaning: "provider-reported" });
  });

  test("a repeated identical completion is one spool entry", () => {
    const { spool, evidence } = setup();
    const item = native({ id: "p", type: "fileChange", status: "completed", changes: [UPDATE] });
    evidence.item(source, "completed", item);
    evidence.item(source, "completed", item);
    expect(spool.read(0).entries).toHaveLength(1);
  });

  test("commands map their real outcome; one that never spawned did not run", () => {
    const { spool, evidence } = setup();
    const command = (raw: Record<string, unknown>) =>
      native({ id: "c", type: "commandExecution", command: "ls", aggregatedOutput: "", ...raw });
    evidence.item(source, "started", command({ status: "inProgress" }));
    evidence.item(source, "completed", command({ status: "failed", exitCode: 2 }));
    evidence.item({ ...source, turnId: "turn-2" }, "completed", command({ status: "declined" }));

    expect(frames(spool).map((frame) => frame.event)).toMatchObject([
      { kind: "tool", toolKind: "shell", phase: "running", executionOccurrence: "started" },
      { kind: "tool", toolKind: "shell", phase: "failed", executionOccurrence: "started" },
      { kind: "tool", toolKind: "shell", phase: "failed", executionOccurrence: "did-not-run" },
    ]);
  });

  test("a raw apply_patch call is an opaque proposal under its own keys", () => {
    const { spool, evidence } = setup();
    const input =
      "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** Add File: src/b.ts\n+b\n*** End Patch";
    evidence.rawApplyPatch(source, "raw-1", input);
    evidence.rawApplyPatch(source, "raw-1", input, "failed");

    const [proposed, failed] = frames(spool);
    expect(proposed!.event).toMatchObject({
      phase: "proposed",
      executionOccurrence: "not-started",
    });
    expect(failed!.event).toMatchObject({ phase: "failed", executionOccurrence: "unknown" });
    expect(updates(proposed!).map((update) => [update.evidenceKey, update.evidence])).toMatchObject(
      [
        [
          "raw-patch:0",
          { kind: "patch", path: "src/a.ts", format: "opaque", effectClaim: "proposal" },
        ],
        ["raw-path:0", { kind: "path-operation", operation: "modify" }],
        ["raw-patch:1", { kind: "patch", path: "src/b.ts", format: "opaque" }],
        ["raw-path:1", { kind: "path-operation", operation: "add" }],
      ],
    );
  });

  test("records every session bound to the thread", () => {
    const { spool, evidence } = setup();
    evidence.turn({ sessionIds: ["s1", "s2"], turnId: "t" }, "running");
    evidence.turn({ sessionIds: ["s1", "s2"], turnId: "t" }, "interrupted");
    expect(
      frames(spool).map((frame) => [
        frame.source.conversationId,
        frame.event.kind === "turn" && frame.event.phase,
      ]),
    ).toEqual([
      ["s1", "running"],
      ["s2", "running"],
      ["s1", "cancelled"],
      ["s2", "cancelled"],
    ]);
  });

  test("the legacy badge value is what the probe's end() returned", () => {
    const change = (): MeasuredWorkspaceChange => ({ additions: 1, deletions: 0, files: [] });
    const observed = (overrides: Partial<ProbeObservation>): ProbeObservation => ({
      change: change(),
      boundary: { before: "prior-observation", after: "after-terminal" },
      overlap: "none-observed",
      omittedReasons: [],
      ...overrides,
    });
    expect(legacyCommandChange(undefined)).toBeUndefined();
    expect(
      legacyCommandChange(observed({ change: undefined, unavailableReason: "x" })),
    ).toBeUndefined();
    expect(legacyCommandChange(observed({}))?.approximate).toBeUndefined();
    expect(legacyCommandChange(observed({ overlap: "known-overlap" }))?.approximate).toBe(true);
    expect(
      legacyCommandChange(observed({ boundary: { before: "late-start", after: "after-terminal" } }))
        ?.approximate,
    ).toBe(true);
    expect(
      legacyCommandChange(observed({ omittedReasons: ["untracked-file-too-large"] }))?.approximate,
    ).toBe(true);
  });

  test("appends synchronously: nothing returned is awaited, the entry is readable at once", () => {
    // The notification path calls these without awaiting; a promise here
    // would be work the app-server stdout loop silently raced.
    const { spool, evidence } = setup();
    const results = [
      evidence.item(
        source,
        "started",
        native({ id: "c", type: "commandExecution", status: "inProgress" }),
      ),
      evidence.turnDiff(source, "@@ -1 +1 @@\n-a\n+b\n"),
      evidence.turn(source, "running"),
    ];
    expect(results).toEqual([undefined, undefined, undefined]);
    expect(spool.read(0).entries).toHaveLength(3);
  });
});

/** Answers `endObservation` from `results`; a missing id is an unmeasured window. */
class FakeProbe implements CommandChangeProbe {
  readonly results = new Map<string, MeasuredWorkspaceChange>();
  readonly calls: string[] = [];
  async begin(_cwd: string, callId: string, _options?: BeginOptions): Promise<void> {
    this.calls.push(`begin ${callId}`);
  }
  async note(_cwd: string, callId: string): Promise<void> {
    this.calls.push(`note ${callId}`);
  }
  async endObservation(callId: string): Promise<ProbeObservation | undefined> {
    this.calls.push(`end ${callId}`);
    const change = this.results.get(callId);
    return change
      ? {
          change,
          boundary: { before: "prior-observation", after: "after-terminal" },
          overlap: "none-observed",
          omittedReasons: [],
        }
      : undefined;
  }
  discard(callId: string): void {
    this.calls.push(`discard ${callId}`);
  }
  async prime(): Promise<void> {}
}

describe("Codex change evidence from the live runtime", () => {
  test("frames name the session the backend addresses and the row's call id", async () => {
    const { spool, evidence } = setup();
    const probe = new FakeProbe();
    const h = await harness({}, { changeEvidence: evidence, commandChangeProbe: probe });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });
    const child = h.child();
    const notify = (method: string, params: Record<string, unknown>) =>
      child.notify(method, { threadId: "thread-1", turnId: "turn-1", ...params });

    child.notify("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
    notify("item/started", {
      item: { id: "patch-1", type: "fileChange", status: "inProgress", changes: [UPDATE] },
    });
    notify("item/completed", {
      item: { id: "patch-1", type: "fileChange", status: "completed", changes: [UPDATE] },
    });
    probe.results.set("cmd-ok", { additions: 2, deletions: 1, files: [] });
    for (const id of ["cmd-ok", "cmd-never"]) {
      notify("item/started", {
        item: { id, type: "commandExecution", command: "make", status: "inProgress" },
      });
    }
    notify("item/completed", {
      item: {
        id: "cmd-ok",
        type: "commandExecution",
        command: "make",
        status: "completed",
        exitCode: 0,
      },
    });
    // Declined: no exit code, so it never ran.
    notify("item/completed", {
      item: { id: "cmd-never", type: "commandExecution", command: "make", status: "declined" },
    });
    notify("turn/diff/updated", { diff: UPDATE.diff });
    child.notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    const all = frames(spool);
    expect(new Set(all.map((frame) => frame.source.conversationId))).toEqual(new Set([sessionId]));
    expect(sessionId).not.toBe("thread-1");
    const patchFrames = all.filter((frame) => frame.source.callId === "patch-1");
    expect(patchFrames.map((frame) => frame.event.kind === "tool" && frame.event.phase)).toEqual([
      "running",
      "succeeded",
    ]);
    const turnFrames = all.filter((frame) => frame.event.kind === "turn");
    expect(turnFrames.map((frame) => frame.event.kind === "turn" && frame.event.phase)).toEqual([
      "running",
      "succeeded",
    ]);
    expect(all.filter((frame) => frame.event.kind === "turn-diff")).toHaveLength(1);
    expect(
      all.find(
        (frame) =>
          frame.source.callId === "cmd-never" &&
          frame.event.kind === "tool" &&
          frame.event.phase !== "running",
      )?.event,
    ).toMatchObject({ phase: "failed", executionOccurrence: "did-not-run" });

    // The measured command reports its window; the one that never ran does not.
    expect(probe.calls).toContain("discard cmd-never");
    expect(observations(spool).map((report) => report.source)).toEqual([
      { conversationId: sessionId, turnId: "turn-1", callId: "cmd-ok" },
    ]);

    // The evidence call id is the transcript row's tool call id.
    const messages = (await h.runtime.getMessages(sessionId))!;
    const toolUseIds = new Set(
      messages.flatMap((message) => message.parts.map((part) => part.toolUseId)),
    );
    for (const callId of ["patch-1", "cmd-ok", "cmd-never"])
      expect(toolUseIds.has(callId)).toBe(true);
    // And the legacy fields still carry the real data.
    const patchPart = messages
      .flatMap((message) => message.parts)
      .find((part) => part.toolUseId === "patch-1");
    expect(patchPart?.toolDiff).toMatchObject({ additions: 1, deletions: 1 });
    const commandPart = messages
      .flatMap((message) => message.parts)
      .find((part) => part.toolUseId === "cmd-ok");
    expect(commandPart?.commandChanges).toEqual({ additions: 2, deletions: 1, files: [] });
  });
});
