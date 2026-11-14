import { describe, expect, test } from "bun:test";
import type {
  NativeAgentTranscriptDelta,
  NativeAgentTranscriptUpdate,
  NativeAgentTranscriptView,
} from "@orkestrator/protocol/native-agent";
import {
  LAUNCH_ROW_SHAPE_LIMIT,
  TokenReader,
  TaskCaseEvidence,
  rowText,
  type Row,
  type BackgroundTask,
} from "../../e2e/agent-testing/claude-revision-token-reader.js";

const identity = {
  environmentId: "environment",
  agent: "claude" as const,
  logicalSessionKey: "tab",
};
const viewIdentity = {
  backendInstanceId: "backend",
  environmentId: identity.environmentId,
  platform: identity.agent,
  logicalSessionKey: identity.logicalSessionKey,
  providerSessionId: "session",
  sourceGeneration: 1,
};
const launch = (detailRef: string, toolState = "running"): Row => ({
  id: "launch",
  role: "assistant",
  parts: [{ type: "tool-invocation", toolUseId: "call", toolName: "Bash", toolState, detailRef }],
});
const answer: Row = { id: "answer", role: "assistant", content: "FINAL-MARKER" };
const view = (messages: Row[]): NativeAgentTranscriptView<Row> => ({
  identity: viewIdentity,
  messages,
  freshness: "current",
  historyEpoch: "epoch",
  historyComplete: true,
});
const snapshot = (token: string, messages: Row[]): NativeAgentTranscriptUpdate<Row> => ({
  viewVersion: 1,
  status: "snapshot",
  token,
  value: view(messages),
});
const delta = (
  changes: Partial<NativeAgentTranscriptDelta<Row>> = {},
): NativeAgentTranscriptUpdate<Row> => ({
  viewVersion: 1,
  status: "delta",
  baseToken: "one",
  token: "two",
  identity: viewIdentity,
  delta: {
    messageUpserts: [launch("final", "success"), answer],
    deletedMessageIds: [],
    liveMessageIds: ["launch", "answer"],
    freshness: "current",
    historyEpoch: "epoch",
    historyComplete: true,
    ...changes,
  },
});

function fixture(
  updates: NativeAgentTranscriptUpdate<Row>[],
  forced = [launch("final", "success"), answer],
) {
  const requests: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const reader = new TokenReader(async <T>(command: string, args?: Record<string, unknown>) => {
    requests.push({ command, args });
    let result: unknown;
    if (command === "get_native_agent_transcript_update") {
      result = args?.forceSnapshot ? snapshot("two", forced) : updates.shift();
      if (!result) throw new Error("Unexpected transcript read");
    } else if (command === "get_native_agent_tool_details") {
      result = { toolOutput: args?.detailRef === "final" ? "background-output" : "task launched" };
    } else {
      result = { status: "snapshot", token: "state", value: { turn: { phase: "idle" } } };
    }
    return result as T;
  }, identity);
  return { reader, requests };
}
const task: BackgroundTask = { id: "new-task", status: "completed", toolUseId: "call" };

describe("conditional Claude qualification reader", () => {
  test("applies updates and checks the retained launching row and its deferred output", async () => {
    const { reader, requests } = fixture([
      snapshot("one", [launch("initial")]),
      delta(),
      { viewVersion: 1, status: "unchanged", token: "two", identity: viewIdentity },
    ]);
    await reader.read();
    await reader.read();
    expect(reader.rows.map((row) => row.id)).toEqual(["launch", "answer"]);
    expect(rowText(reader.rows[1]!)).toBe("FINAL-MARKER");
    await reader.expectTaskOutput(task, "Bash", "background-output");
    await reader.expectForcedComparison();
    await reader.read();
    expect(
      requests
        .filter((r) => r.command === "get_native_agent_transcript_update")
        .map((r) => r.args?.knownToken),
    ).toEqual([undefined, "one", undefined, "two"]);
    expect(reader.transcriptToken).toBe("two");
  });

  test("fails when a token advances and the answer arrives but the background row update is omitted", async () => {
    const { reader } = fixture([
      snapshot("one", [launch("initial", "success")]),
      delta({ messageUpserts: [answer] }),
    ]);
    await reader.read();
    await reader.read();
    expect(reader.transcriptToken).toBe("two");
    expect(rowText(reader.rows[1]!)).toBe("FINAL-MARKER");
    // A separate forced snapshot has the correct task result; it cannot repair
    // the conditional view or make the live qualification's output check pass.
    expect((await reader.forcedRows())[0]).toEqual(launch("final", "success"));
    await expect(reader.expectTaskOutput(task, "Bash", "background-output")).rejects.toThrow(
      "lacks the final background output",
    );
    await expect(reader.expectForcedComparison()).rejects.toThrow("differs");
    expect(reader.rows[0]).toEqual(launch("initial", "success"));
  });

  test("accepts a Bash terminal summary when the provider defers stdout to an output file", async () => {
    const { reader } = fixture([snapshot("one", [launch("final", "success")])]);
    await reader.read();
    await expect(
      reader.expectTaskOutput({ ...task, summary: "background-output" }, "Bash", "stdout-marker"),
    ).resolves.toBeUndefined();
  });

  test("rejects a missing final launching state", async () => {
    const { reader } = fixture([snapshot("one", [launch("final")])]);
    await reader.read();
    await expect(reader.expectTaskOutput(task, "Bash", "background-output")).rejects.toThrow(
      "settled launching tool row",
    );
  });

  test("rejects a mismatched delta base without advancing the token", async () => {
    const update = delta();
    if (update.status !== "delta") throw new Error("fixture");
    update.baseToken = "other";
    const { reader } = fixture([snapshot("one", [launch("initial")]), update]);
    await reader.read();
    await expect(reader.read()).rejects.toThrow("no matching base");
    expect(reader.transcriptToken).toBe("one");
  });

  test("rejects a delta that the protocol helper cannot apply", async () => {
    const { reader } = fixture([
      snapshot("one", [launch("initial")]),
      delta({ liveMessageIds: ["absent"] }),
    ]);
    await reader.read();
    await expect(reader.read()).rejects.toThrow("could not be applied");
    expect(reader.transcriptToken).toBe("one");
  });

  test("applies deletions and membership order, then accepts a replacement snapshot", async () => {
    const { reader } = fixture([
      snapshot("one", [launch("initial")]),
      delta({
        messageUpserts: [answer],
        deletedMessageIds: ["launch"],
        liveMessageIds: ["answer"],
      }),
      snapshot("three", [launch("final", "success")]),
    ]);
    await reader.read();
    await reader.read();
    expect(reader.rows).toEqual([answer]);
    await reader.read();
    expect(reader.rows).toEqual([launch("final", "success")]);
    expect(reader.transcriptToken).toBe("three");
  });

  test("rejects unchanged responses without the retained token", async () => {
    const { reader } = fixture([
      { viewVersion: 1, status: "unchanged", token: "two", identity: viewIdentity },
    ]);
    await expect(reader.read()).rejects.toThrow("no matching retained view");
  });
});

function lifecycle(baseline: BackgroundTask[] = []) {
  const { reader } = fixture([]);
  const evidence = new TaskCaseEvidence(baseline);
  const observe = (phase: string, tasks: BackgroundTask[], changed = false) => {
    reader.phase = phase;
    reader.tasks = tasks;
    evidence.observe(reader, changed);
  };
  return { evidence, observe };
}

describe("case-specific inactive task evidence", () => {
  test("requires a new task running at idle, then completion and a transcript continuation", () => {
    const { evidence, observe } = lifecycle([{ ...task, id: "old-task" }]);
    observe("running", [{ ...task, status: "running" }], true);
    observe("idle", [{ ...task, status: "running" }]);
    observe("running", [task], true);
    observe("idle", [task]);
    expect(() => evidence.expectComplete()).not.toThrow();
    expect(evidence.settledTask).toEqual(task);
  });

  test("a previous case's completed task cannot qualify the next case", () => {
    const { evidence, observe } = lifecycle([task]);
    observe("idle", [task], true);
    expect(() => evidence.expectComplete()).toThrow("No new background task");
  });

  test("an unobserved running transition cannot qualify", () => {
    const { evidence, observe } = lifecycle();
    observe("idle", [task], true);
    expect(() => evidence.expectComplete()).toThrow("observed running");
  });

  test("a task completing before foreground idle cannot qualify", () => {
    const { evidence, observe } = lifecycle();
    observe("running", [{ ...task, status: "running" }], true);
    observe("idle", [task], true);
    expect(() => evidence.expectComplete()).toThrow("idle was never observed");
  });

  test("state-only completion without a post-idle transcript change cannot qualify", () => {
    const { evidence, observe } = lifecycle();
    observe("idle", [{ ...task, status: "running" }], true);
    observe("idle", [task]);
    expect(() => evidence.expectComplete()).toThrow("No transcript continuation");
  });

  test("the same task must run at idle and then complete successfully", () => {
    const { evidence, observe } = lifecycle();
    observe("idle", [{ ...task, status: "running" }]);
    observe(
      "idle",
      [
        { ...task, status: "failed" },
        { ...task, id: "different" },
      ],
      true,
    );
    expect(() => evidence.expectComplete()).toThrow("never completed");
  });
});

/**
 * A reader whose state reports `tasks` and whose transcript answers each read
 * with the next snapshot. Detail references resolve to `outputs`.
 */
function shapeFixture(
  reads: Array<{ rows: Row[]; tasks: BackgroundTask[]; phase?: string }>,
  outputs: Record<string, string | Error>,
) {
  const detailReads: string[] = [];
  let index = -1;
  const reader = new TokenReader(async <T>(command: string, args?: Record<string, unknown>) => {
    let result: unknown;
    if (command === "get_native_agent_transcript_update") {
      index += 1;
      const next = reads[index];
      if (!next) throw new Error("Unexpected transcript read");
      result = snapshot(`token-${index}`, next.rows);
    } else if (command === "get_native_agent_tool_details") {
      const ref = String(args?.detailRef);
      detailReads.push(ref);
      const output = outputs[ref];
      if (output instanceof Error) throw output;
      result = { toolOutput: output };
    } else {
      const current = reads[index]!;
      result = {
        status: "snapshot",
        token: `state-${index}`,
        value: { turn: { phase: current.phase ?? "idle" }, backgroundTasks: current.tasks },
      };
    }
    return result as T;
  }, identity);
  return { reader, detailReads };
}

const SECRET_OUTPUT = "bg-secret-output";
const SECRET_SUMMARY = "secret summary text";

describe("content-free launching row shape (5040)", () => {
  const running: BackgroundTask = { id: "task-secret-id", status: "running", toolUseId: "call" };
  const completed: BackgroundTask = { ...running, status: "completed", summary: SECRET_SUMMARY };

  test("records the row before and after the notification, one record per change", async () => {
    const { reader, detailReads } = shapeFixture(
      [
        { rows: [launch("placeholder-ref", "success")], tasks: [running], phase: "running" },
        { rows: [launch("placeholder-ref", "success")], tasks: [running], phase: "idle" },
        { rows: [launch("placeholder-ref", "success")], tasks: [running], phase: "idle" },
        { rows: [launch("final-ref", "success"), answer], tasks: [completed] },
      ],
      { "placeholder-ref": "task launched", "final-ref": `output ${SECRET_OUTPUT}` },
    );
    for (let read = 0; read < 4; read += 1) await reader.read();
    await reader.expectTaskOutput(completed, "Bash", SECRET_OUTPUT);

    expect(reader.launchRowHistory(completed).map(({ atMs: _atMs, ...shape }) => shape)).toEqual([
      {
        task: 1,
        taskStatus: "running",
        phase: "running",
        row: "present",
        toolName: "Bash",
        toolState: "success",
        hasDetailRef: true,
        detailRefs: 1,
        outputLength: "task launched".length,
        summaryLength: 0,
      },
      {
        task: 1,
        taskStatus: "running",
        phase: "idle",
        row: "present",
        toolName: "Bash",
        toolState: "success",
        hasDetailRef: true,
        detailRefs: 1,
        outputLength: "task launched".length,
        summaryLength: 0,
      },
      {
        task: 1,
        taskStatus: "completed",
        phase: "idle",
        row: "present",
        toolName: "Bash",
        toolState: "success",
        hasDetailRef: true,
        detailRefs: 2,
        outputLength: `output ${SECRET_OUTPUT}`.length,
        summaryLength: SECRET_SUMMARY.length,
      },
    ]);
    // Each distinct reference is resolved once for the history, plus the check's own read.
    expect(detailReads).toEqual(["placeholder-ref", "final-ref", "final-ref"]);
    expect(reader.lastLaunchRowCheck).toEqual({
      task: 1,
      row: "present",
      toolState: "success",
      hasDetailRef: true,
      outputLength: `output ${SECRET_OUTPUT}`.length,
      containsOutput: true,
      containsSummary: false,
      summaryLength: SECRET_SUMMARY.length,
    });
  });

  test("keeps the failed comparison and writes no ids, references or text", async () => {
    const { reader } = shapeFixture(
      [
        { rows: [launch("placeholder-ref", "success")], tasks: [running] },
        { rows: [launch("placeholder-ref", "success"), answer], tasks: [completed] },
      ],
      { "placeholder-ref": "task launched" },
    );
    await reader.read();
    await reader.read();
    await expect(reader.expectTaskOutput(completed, "Bash", SECRET_OUTPUT)).rejects.toThrow(
      "lacks the final background output",
    );

    expect(reader.lastLaunchRowCheck).toMatchObject({
      outputLength: "task launched".length,
      containsOutput: false,
      containsSummary: false,
    });
    expect(reader.launchRowHistory(completed).map((shape) => shape.detailRefs)).toEqual([1, 1]);
    const written = JSON.stringify({
      shapes: reader.launchRowShapes,
      check: reader.lastLaunchRowCheck,
    });
    for (const secret of [
      "task-secret-id",
      "call",
      "placeholder-ref",
      "task launched",
      SECRET_OUTPUT,
      SECRET_SUMMARY,
      "FINAL-MARKER",
    ]) {
      expect(written).not.toContain(secret);
    }
  });

  test("an absent row, an inline output and an unreadable reference are shapes too", async () => {
    const inline: Row = {
      id: "launch",
      role: "assistant",
      parts: [
        {
          type: "tool-invocation",
          toolUseId: "call",
          toolName: "Bash",
          toolState: "success",
          toolOutput: "inline",
        },
      ],
    };
    const { reader } = shapeFixture(
      [
        { rows: [], tasks: [running] },
        { rows: [inline], tasks: [running] },
        { rows: [launch("broken-ref", "success")], tasks: [running] },
      ],
      { "broken-ref": new Error("detail unavailable") },
    );
    await reader.read();
    await reader.read();
    await reader.read();

    expect(
      reader
        .launchRowHistory(running)
        .map(({ row, hasDetailRef, outputLength }) => ({ row, hasDetailRef, outputLength })),
    ).toEqual([
      { row: "absent", hasDetailRef: false, outputLength: null },
      { row: "present", hasDetailRef: false, outputLength: "inline".length },
      { row: "present", hasDetailRef: true, outputLength: null },
    ]);
  });

  test("the history is bounded and counts what it drops", async () => {
    const reads = Array.from({ length: LAUNCH_ROW_SHAPE_LIMIT + 5 }, (_, read) => ({
      rows: [launch("ref", "success")],
      tasks: [{ ...running, summary: "x".repeat(read) }],
    }));
    const { reader } = shapeFixture(reads, { ref: "task launched" });
    for (let read = 0; read < reads.length; read += 1) await reader.read();

    expect(reader.launchRowShapes).toHaveLength(LAUNCH_ROW_SHAPE_LIMIT);
    expect(reader.droppedLaunchRowShapes).toBe(5);
  });
});
