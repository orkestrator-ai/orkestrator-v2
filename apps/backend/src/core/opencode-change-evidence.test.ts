import { describe, expect, test } from "bun:test";
import type {
  ProviderEvidence,
  ProviderEvidenceFrame,
  ProviderEvidenceUpdate,
  WorkspaceObservationReport,
} from "@orkestrator/protocol/change-evidence";
import { OpenCodeMessageIdCoordinator } from "@orkestrator/protocol/opencode-message-id";
import type { MeasuredWorkspaceChange } from "@orkestrator/protocol/tool-diff";
import { openCodeFake, waitUntil } from "./agent-provider-test-support.js";
import {
  OpenCodeChangeEvidence,
  openCodePatchFormat,
  openCodeToolEvidence,
} from "./opencode-change-evidence.js";
import { OpenCodeCommandChanges, type CommandChangeProbe } from "./opencode-command-changes.js";
import { OpenCodeProvider } from "./opencode-provider.js";

const OWNED = new Set(["session-1"]);

// OpenCode 1.19 `edit`: jsdiff two-file patch on both `diff` and `filediff.patch`.
const EDIT_PATCH = [
  "Index: /repo/src/a.ts",
  "===================================================================",
  "--- /repo/src/a.ts",
  "+++ /repo/src/a.ts",
  "@@ -1,2 +1,2 @@",
  " keep",
  "-old",
  "+new",
  "",
].join("\n");

function editState(status: string, patch = EDIT_PATCH) {
  return {
    status,
    input: { filePath: "/repo/src/a.ts", oldString: "old", newString: "new" },
    title: "src/a.ts",
    metadata: {
      diff: patch,
      filediff: { file: "/repo/src/a.ts", patch, additions: 1, deletions: 1 },
      diagnostics: {},
    },
  };
}

function partEvent(
  tool: string,
  state: Record<string, unknown>,
  callID = "call-1",
  sessionID = "session-1",
  messageID = "assistant-1",
) {
  return {
    type: "message.part.updated",
    properties: {
      sessionID,
      part: { id: `part-${callID}`, sessionID, messageID, type: "tool", callID, tool, state },
    },
  };
}

function frames(adapter: OpenCodeChangeEvidence): ProviderEvidenceFrame[] {
  return adapter.spool
    .read(0)
    .entries.flatMap((entry) => (entry.type === "frame" ? [entry.frame] : []));
}

function toolFrames(adapter: OpenCodeChangeEvidence) {
  return frames(adapter).filter(
    (frame): frame is ProviderEvidenceFrame & { event: { kind: "tool" } } =>
      frame.event.kind === "tool",
  );
}

function replaceUpdates(frame: ProviderEvidenceFrame) {
  if (frame.event.kind !== "tool") return [];
  return frame.event.evidence.filter(
    (update): update is Extract<ProviderEvidenceUpdate, { kind: "replace" }> =>
      update.kind === "replace",
  );
}

function block(frame: ProviderEvidenceFrame, key: string): ProviderEvidence | undefined {
  return replaceUpdates(frame).find((update) => update.evidenceKey === key)?.evidence;
}

function text(adapter: OpenCodeChangeEvidence, id: string): string | null {
  const bytes = adapter.spool.readBody(id);
  return bytes ? new TextDecoder().decode(bytes) : null;
}

describe("openCodeToolEvidence", () => {
  test("keeps the applied patch, reported counts and the input proposal as independent blocks", () => {
    const evidence = openCodeToolEvidence("edit", editState("completed"));
    expect(evidence.map((input) => [input.key, input.kind, input.claim])).toEqual([
      ["result:patch", "patch", "provider-reported"],
      ["result:counts", "reported-counts", "provider-reported"],
      ["input:replacement", "replacement", "proposal"],
    ]);
    expect(evidence[0]).toMatchObject({ format: "git_unified", path: "/repo/src/a.ts" });
    expect(evidence[1]).toMatchObject({ additions: 1, deletions: 1, scope: "file" });
    expect(evidence[2]).toMatchObject({
      extent: "fragment",
      origin: "input",
      before: "old",
      after: "new",
    });
  });

  test("labels a patch without hunks as opaque", () => {
    expect(openCodePatchFormat(EDIT_PATCH)).toBe("git_unified");
    expect(openCodePatchFormat("*** Begin Patch\n*** Update File: a\n*** End Patch")).toBe(
      "opaque",
    );
    expect(openCodePatchFormat("@@ -1 +1 @@\n-a\n+b\n")).toBe("opaque");
  });

  test("an empty filediff before is unknown unless OpenCode established a new file", () => {
    const sides = (filediff: Record<string, unknown>) =>
      openCodeToolEvidence("edit", {
        status: "completed",
        input: {},
        metadata: { filediff: { file: "b.ts", after: "x\n", ...filediff } },
      }).find((input) => input.key === "result:replacement");
    expect(sides({ before: "" })).toMatchObject({
      before: undefined,
      unknownReason: "provider-empty-before-ambiguous",
      extent: "whole-file",
      origin: "result",
      claim: "provider-reported",
    });
    expect(sides({ before: "", status: "added" })).toMatchObject({ before: null });
    expect(sides({ before: "y\n" })).toMatchObject({ before: "y\n", after: "x\n" });
  });

  test("a write proposal has an unknown before side and its result only an operation", () => {
    const evidence = openCodeToolEvidence("write", {
      status: "completed",
      input: { filePath: "/repo/new.ts", content: "hello\n" },
      title: "new.ts",
      metadata: { filepath: "/repo/new.ts", exists: false, diagnostics: {} },
    });
    expect(evidence).toEqual([
      {
        kind: "path-operation",
        key: "result:operation",
        path: "/repo/new.ts",
        operation: "add",
        claim: "provider-reported",
      },
      {
        kind: "replacement",
        key: "input:content",
        path: "/repo/new.ts",
        before: undefined,
        after: "hello\n",
        unknownReason: "prior-content-not-captured",
        extent: "whole-file",
        origin: "input",
        claim: "proposal",
      },
    ]);
  });

  test("apply_patch reports one block per file instead of the concatenated diff", () => {
    const evidence = openCodeToolEvidence("apply_patch", {
      status: "completed",
      input: { patchText: "*** Begin Patch\n*** End Patch" },
      metadata: {
        diff: `${EDIT_PATCH}${EDIT_PATCH}`,
        files: [
          {
            filePath: "/repo/a.ts",
            relativePath: "a.ts",
            type: "update",
            patch: EDIT_PATCH,
            additions: 1,
            deletions: 1,
          },
          {
            filePath: "/repo/old.ts",
            relativePath: "new.ts",
            movePath: "/repo/new.ts",
            type: "move",
            patch: EDIT_PATCH,
            additions: 1,
            deletions: 1,
          },
        ],
      },
    });
    expect(evidence.map((input) => input.key)).toEqual([
      "result:file:a.ts:patch",
      "result:file:a.ts:counts",
      "result:file:a.ts:operation",
      "result:file:new.ts:patch",
      "result:file:new.ts:counts",
      "result:file:new.ts:operation",
      "input:patch",
    ]);
    expect(evidence[5]).toMatchObject({ operation: "rename", previousPath: "/repo/old.ts" });
    expect(evidence[6]).toMatchObject({ format: "opaque", claim: "proposal" });
  });

  test("non-file tools carry no file evidence", () => {
    expect(openCodeToolEvidence("bash", { status: "completed", input: { command: "ls" } })).toEqual(
      [],
    );
    expect(openCodeToolEvidence("read", { status: "completed", input: { filePath: "a" } })).toEqual(
      [],
    );
  });
});

describe("OpenCodeChangeEvidence", () => {
  test("one operation per callID; a changed result supersedes, settling keeps evidence", () => {
    const adapter = new OpenCodeChangeEvidence({ location: "host" });
    const revised = EDIT_PATCH.replace("+new", "+newer");
    adapter.observeScoped(partEvent("edit", { status: "pending", input: {}, raw: "" }), OWNED);
    adapter.observeScoped(partEvent("edit", editState("running")), OWNED);
    adapter.observeScoped(partEvent("edit", editState("completed", revised)), OWNED);

    const tools = toolFrames(adapter);
    expect(tools.map((frame) => [frame.event.phase, frame.event.executionOccurrence])).toEqual([
      ["running", "not-started"],
      ["running", "started"],
      ["succeeded", "started"],
    ]);
    for (const frame of tools) {
      expect(frame.source).toMatchObject({ conversationId: "session-1", callId: "call-1" });
      expect(frame.event.toolKind).toBe("file-edit");
    }
    const first = replaceUpdates(tools[1]!).find((u) => u.evidenceKey === "result:patch")!;
    const second = replaceUpdates(tools[2]!).find((u) => u.evidenceKey === "result:patch")!;
    expect(second.replacesRevisionKey).toBe(first.revisionKey);
    const body = (second.evidence as Extract<ProviderEvidence, { kind: "patch" }>).body;
    expect(text(adapter, body.id)).toBe(revised);
    // The unchanged proposal keeps its revision instead of being re-declared.
    expect(
      replaceUpdates(tools[2]!).find((u) => u.evidenceKey === "input:replacement"),
    ).toMatchObject({
      revisionKey: replaceUpdates(tools[1]!).find((u) => u.evidenceKey === "input:replacement")!
        .revisionKey,
    });
    expect(
      replaceUpdates(tools[2]!).find((u) => u.evidenceKey === "input:replacement")
        ?.replacesRevisionKey,
    ).toBeUndefined();
  });

  test("an error without metadata settles the call without replacing earlier result evidence", () => {
    const adapter = new OpenCodeChangeEvidence({ location: "host" });
    adapter.observeScoped(partEvent("edit", editState("running")), OWNED);
    adapter.observeScoped(
      partEvent("edit", {
        status: "error",
        input: editState("running").input,
        error: "Tool execution aborted",
      }),
      OWNED,
    );
    const [running, failed] = toolFrames(adapter);
    expect(block(running!, "result:patch")?.kind).toBe("patch");
    expect(failed!.event).toMatchObject({ phase: "failed", executionOccurrence: "started" });
    expect(replaceUpdates(failed!).map((u) => u.evidenceKey)).toEqual(["input:replacement"]);
    // The earlier body is still retained for the backend to fetch.
    const patch = block(running!, "result:patch") as Extract<ProviderEvidence, { kind: "patch" }>;
    expect(text(adapter, patch.body.id)).toBe(EDIT_PATCH);
  });

  test("a write's unknown prior content is never an empty before-image", () => {
    const adapter = new OpenCodeChangeEvidence({ location: "host" });
    adapter.observeScoped(
      partEvent("write", { status: "running", input: { filePath: "/repo/x.ts", content: "x\n" } }),
      OWNED,
    );
    const evidence = block(toolFrames(adapter)[0]!, "input:content");
    expect(evidence).toMatchObject({
      kind: "replacement",
      before: { state: "unknown", reason: "prior-content-not-captured" },
      after: { state: "present" },
      effectClaim: "proposal",
    });
    expect(toolFrames(adapter)[0]!.event.toolKind).toBe("file-write");
  });

  test("replayed updates are deduplicated and other sessions are ignored", () => {
    const adapter = new OpenCodeChangeEvidence({ location: "host" });
    adapter.observeScoped(partEvent("edit", editState("running")), OWNED);
    adapter.observeScoped(partEvent("edit", editState("running")), OWNED);
    adapter.observeScoped(partEvent("edit", editState("running"), "call-x", "foreign"), OWNED);
    expect(toolFrames(adapter)).toHaveLength(1);
    const before = adapter.spool.stats().bodies;
    adapter.observeScoped(partEvent("edit", editState("running")), OWNED);
    expect(adapter.spool.stats().bodies).toBe(before);
  });

  test("tool kinds follow the OpenCode tool name", () => {
    const adapter = new OpenCodeChangeEvidence({ location: "host" });
    const tools = [
      "bash",
      "multiedit",
      "patch",
      "read",
      "grep",
      "glob",
      "list",
      "task",
      "webfetch",
    ];
    tools.forEach((tool, index) =>
      adapter.observeScoped(partEvent(tool, { status: "running", input: {} }, `c-${index}`), OWNED),
    );
    expect(toolFrames(adapter).map((frame) => frame.event.toolKind)).toEqual([
      "shell",
      "file-edit",
      "file-edit",
      "read",
      "read",
      "read",
      "read",
      "other",
      "other",
    ]);
  });

  test("a pending permission is awaiting-approval and a rejection is denied", () => {
    const adapter = new OpenCodeChangeEvidence({ location: "host" });
    adapter.observeScoped(
      partEvent("bash", { status: "running", input: { command: "rm x" } }),
      OWNED,
    );
    adapter.observeScoped(
      {
        type: "permission.asked",
        properties: {
          id: "perm-1",
          sessionID: "session-1",
          permission: "bash",
          patterns: ["rm x"],
          metadata: {},
          always: [],
          tool: { messageID: "assistant-1", callID: "call-1" },
        },
      },
      OWNED,
    );
    adapter.observeScoped(
      {
        type: "permission.replied",
        properties: { sessionID: "session-1", requestID: "perm-1", reply: "reject" },
      },
      OWNED,
    );
    adapter.observeScoped(
      partEvent("bash", { status: "error", input: { command: "rm x" }, error: "rejected" }),
      OWNED,
    );
    expect(
      toolFrames(adapter).map((frame) => [frame.event.phase, frame.event.executionOccurrence]),
    ).toEqual([
      ["running", "started"],
      ["awaiting-approval", "not-started"],
      ["denied", "did-not-run"],
    ]);
  });

  test("turn frames open on dispatch and on a foreign prompt, settle on idle; tools carry the turn", () => {
    const adapter = new OpenCodeChangeEvidence({ location: "host" });
    adapter.beginTurn("session-1", "user-1");
    adapter.observeScoped(
      {
        type: "message.updated",
        properties: {
          sessionID: "session-1",
          info: {
            id: "assistant-1",
            sessionID: "session-1",
            role: "assistant",
            parentID: "user-1",
          },
        },
      },
      OWNED,
    );
    adapter.observeScoped(partEvent("bash", { status: "running", input: {} }), OWNED);
    adapter.observeScoped(
      {
        type: "session.error",
        properties: { sessionID: "session-1", error: { name: "MessageAbortedError" } },
      },
      OWNED,
    );
    adapter.observeScoped({ type: "session.idle", properties: { sessionID: "session-1" } }, OWNED);
    // A prompt from another client opens its own turn.
    adapter.observeScoped(
      {
        type: "message.updated",
        properties: {
          sessionID: "session-1",
          info: { id: "user-2", sessionID: "session-1", role: "user" },
        },
      },
      OWNED,
    );
    adapter.observeScoped(
      { type: "session.status", properties: { sessionID: "session-1", status: { type: "idle" } } },
      OWNED,
    );

    const turns = frames(adapter).filter((frame) => frame.event.kind === "turn");
    expect(
      turns.map((frame) => [frame.source.turnId, frame.event.kind === "turn" && frame.event.phase]),
    ).toEqual([
      ["user-1", "running"],
      ["user-1", "cancelled"],
      ["user-2", "running"],
      ["user-2", "succeeded"],
    ]);
    expect(toolFrames(adapter)[0]!.source.turnId).toBe("user-1");
  });

  test("a child session's tools name the owning session and spawning call", () => {
    const adapter = new OpenCodeChangeEvidence({ location: "host" });
    adapter.observeScoped(
      partEvent(
        "task",
        { status: "running", input: {}, metadata: { sessionId: "child-1" } },
        "task-1",
      ),
      OWNED,
    );
    adapter.observeScoped(partEvent("edit", editState("running"), "child-edit", "child-1"), OWNED);
    adapter.observeScoped(
      { type: "session.updated", properties: { info: { id: "grandchild", parentID: "child-1" } } },
      OWNED,
    );
    adapter.observeScoped(
      partEvent("bash", { status: "running", input: {} }, "deep", "grandchild"),
      OWNED,
    );

    const [, child, grandchild] = toolFrames(adapter);
    expect(child!.source).toMatchObject({
      conversationId: "child-1",
      callId: "child-edit",
      parentConversationId: "session-1",
      parentCallId: "task-1",
    });
    expect(grandchild!.source).toMatchObject({
      conversationId: "grandchild",
      parentConversationId: "session-1",
    });
    expect(grandchild!.source.parentCallId).toBeUndefined();
  });

  test("declares host and container capabilities; a container is never captured as a host path", () => {
    const host = new OpenCodeChangeEvidence({ location: "host" });
    const container = new OpenCodeChangeEvidence({ location: "container" });
    expect(host.spool.read(0).capabilities[0]).toMatchObject({
      beforeTool: "observed-after-start",
      afterTool: "observed",
      beforeTurn: "controlled-dispatch",
      afterTurn: "terminal-observed",
      historicalCallIdentity: "stable",
      fileEvidence: { resolution: "confirmed", kinds: ["patch", "replacement", "reported-counts"] },
      turnDiff: "absent",
      backgroundCompletion: "unknown",
      captureExecutor: "host-worker",
      captureAvailability: "ready",
    });
    expect(container.spool.read(0).capabilities[0]).toMatchObject({
      captureExecutor: "container-worker",
      captureAvailability: "unavailable",
    });
    expect(host.recorder.capabilityRevision).not.toBe(container.recorder.capabilityRevision);
  });

  test("the evidence source rereads from the start on a new epoch and releases on ack", async () => {
    const adapter = new OpenCodeChangeEvidence({ location: "host" });
    adapter.observeScoped(partEvent("edit", editState("running")), OWNED);
    const source = adapter.evidenceSource("env-1", "opencode:test");
    expect(source).toMatchObject({
      provider: "opencode",
      environmentId: "env-1",
      sourceKey: "opencode:test",
    });
    const first = await source.read(0, null);
    if (first === "unsupported") throw new Error("expected entries");
    expect(first.entries).toHaveLength(1);
    expect(await source.read(first.nextCursor, first.runtimeEpoch)).toMatchObject({ entries: [] });
    expect(
      (await source.read(first.nextCursor, "old-epoch")) as { entries: unknown[] },
    ).toMatchObject({
      entries: [{ seq: 1 }],
    });
    const patch = block(
      first.entries[0]!.type === "frame" ? first.entries[0]!.frame : (null as never),
      "result:patch",
    ) as Extract<ProviderEvidence, { kind: "patch" }>;
    expect(new TextDecoder().decode((await source.body(patch.body.id))!)).toBe(EDIT_PATCH);
    await source.ack({
      runtimeEpoch: first.runtimeEpoch,
      upTo: first.nextCursor,
      retainedBodyIds: [patch.body.id],
      unavailableBodyIds: [],
    });
    expect(adapter.spool.stats()).toMatchObject({ entries: 0 });
    expect(await source.body(patch.body.id)).toBeNull();
  });
});

const CHANGE: MeasuredWorkspaceChange = {
  additions: 2,
  deletions: 1,
  files: [{ path: "a.txt", status: "M", additions: 2, deletions: 1 }],
};

function fakeProbe(): CommandChangeProbe {
  return {
    begin: async () => undefined,
    note: async () => undefined,
    endObservation: async () => ({
      change: structuredClone(CHANGE),
      boundary: { before: "prior-observation", after: "after-terminal" },
      overlap: "known-overlap",
      omittedReasons: [],
    }),
    discard: () => undefined,
    prime: async () => undefined,
  };
}

function observations(adapter: OpenCodeChangeEvidence): WorkspaceObservationReport[] {
  return adapter.spool
    .read(0)
    .entries.flatMap((entry) => (entry.type === "observation" ? [entry.report] : []));
}

describe("OpenCode shell observations", () => {
  test("a closed shell window is reported and the legacy badge is unchanged", async () => {
    const adapter = new OpenCodeChangeEvidence({ location: "host" });
    const measured: string[] = [];
    const tracker = new OpenCodeCommandChanges(
      "/repo",
      { probe: fakeProbe() },
      (id) => measured.push(id),
      (sessionId, callId, observation) => adapter.shellObservation(sessionId, callId, observation),
    );
    adapter.beginTurn("session-1", "user-1");
    for (const status of ["running", "completed"]) {
      const event = partEvent("bash", { status, input: { command: "sed" } });
      tracker.observe(event);
      adapter.observeScoped(event, OWNED);
    }
    await waitUntil(() => measured.length === 1);

    expect(observations(adapter)).toEqual([
      expect.objectContaining({
        source: { conversationId: "session-1", turnId: "user-1", callId: "call-1" },
        executor: "host-worker",
        boundary: { before: "prior-observation", after: "after-terminal" },
        overlap: "known-overlap",
        outcome: expect.objectContaining({ kind: "measured", additions: 2, deletions: 1 }),
      }),
    ]);
    // Overlap still marks the badge approximate, exactly as `end()` did.
    expect((await tracker.changes("session-1")).get("call-1")).toEqual({
      ...CHANGE,
      approximate: true,
    });
  });
});

describe("OpenCodeProvider change evidence", () => {
  function provider(fake: ReturnType<typeof openCodeFake>, directory?: string) {
    return new OpenCodeProvider(
      {
        agent: "opencode",
        baseUrl: "http://opencode.test",
        authToken: "test-token",
        ...(directory ? { directory } : {}),
      },
      {
        openCodeClient: fake.client,
        openCodeMessageIdCoordinator: new OpenCodeMessageIdCoordinator(),
        monitorRetryMs: 1,
        openCodeStatusReconcileIntervalMs: 60_000,
        commandChanges: { probe: fakeProbe() },
      },
    );
  }

  test("feeds tool frames and shell observations from the SSE stream", async () => {
    const fake = openCodeFake();
    const subject = provider(fake, "/worktree");
    subject.registerSession("session-1");
    try {
      await waitUntil(() => fake.subscriptions.length === 1);
      const stream = fake.subscriptions[0]!;
      stream.push(partEvent("bash", { status: "running", input: { command: "make" } }));
      stream.push(
        partEvent("bash", { status: "completed", input: { command: "make" }, output: "" }),
      );
      await waitUntil(() => observations(subject.changeEvidence).length === 1);
      expect(toolFrames(subject.changeEvidence).map((frame) => frame.event.phase)).toEqual([
        "running",
        "succeeded",
      ]);
      const source = subject.changeEvidenceSource("env-1");
      expect(source.provider).toBe("opencode");
      expect(source.sourceKey).toMatch(/^opencode:/);
      expect(source.sourceKey).not.toContain("test-token");
      expect(subject.changeEvidenceSource("env-1").sourceKey).toBe(source.sourceKey);
    } finally {
      await subject.dispose();
    }
  });

  test("a container connection declares an unavailable container worker and emits no observations", async () => {
    const fake = openCodeFake();
    const subject = provider(fake);
    subject.registerSession("session-1");
    try {
      await waitUntil(() => fake.subscriptions.length === 1);
      const stream = fake.subscriptions[0]!;
      stream.push(partEvent("bash", { status: "running", input: { command: "make" } }));
      stream.push(
        partEvent("bash", { status: "completed", input: { command: "make" }, output: "" }),
      );
      await waitUntil(() => toolFrames(subject.changeEvidence).length === 2);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(observations(subject.changeEvidence)).toEqual([]);
      expect(subject.changeEvidence.spool.read(0).capabilities[0]).toMatchObject({
        captureExecutor: "container-worker",
        captureAvailability: "unavailable",
      });
    } finally {
      await subject.dispose();
    }
  });

  test("a dispatch opens the turn under the user message id it sends", async () => {
    const fake = openCodeFake();
    const subject = provider(fake);
    subject.registerSession("owned-session");
    try {
      await waitUntil(() => fake.subscriptions.length === 1);
      await subject.send("owned-session", "Run it", { requestId: "request-1" });
      const turn = frames(subject.changeEvidence).find((frame) => frame.event.kind === "turn");
      expect(turn?.event).toMatchObject({
        kind: "turn",
        phase: "running",
        writerLiveness: "may-write",
      });
      expect(turn?.source.conversationId).toBe("owned-session");
      expect(turn?.source.turnId).toBeTruthy();
    } finally {
      await subject.dispose();
    }
  });
});
