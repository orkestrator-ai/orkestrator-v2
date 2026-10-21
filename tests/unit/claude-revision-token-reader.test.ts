import { describe, expect, test } from "bun:test";
import type {
  NativeAgentTranscriptDelta,
  NativeAgentTranscriptUpdate,
  NativeAgentTranscriptView,
} from "@orkestrator/protocol/native-agent";
import {
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
