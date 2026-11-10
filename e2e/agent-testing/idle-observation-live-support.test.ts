import { idleObservationModel, asyncQuestionPrompt } from "./idle-observation-live-support";
import { finalReply, scriptedStep } from "./idle-observation-fake-claude";
import { describe, expect, test } from "bun:test";
import {
  requireRecoveredBackoff,
  IDLE_OBSERVATION_CASES,
  backgroundOutputEvidence,
  completedTaskOutputFiles,
  droppableGatewayEvent,
  failedCases,
  freshToolResults,
  freshToolStates,
  shellOutputContainsMarker,
  gapHistogram,
  discoveryRenewalDelta,
  invalidationCauseDelta,
  readCadence,
  readGaps,
  selectedCases,
  sidebarActivityFromMarkerState,
} from "./idle-observation-live-support";

describe("idle observation live support", () => {
  test("case selection keeps the canonical order and rejects unknown names", () => {
    expect(selectedCases(undefined)).toEqual([...IDLE_OBSERVATION_CASES]);
    expect(selectedCases(" hidden , approval ")).toEqual(["approval", "hidden"]);
    expect(() => selectedCases("approval,typo")).toThrow("typo");
  });

  test("tool states name fresh calls and sub-agent cards without their content", () => {
    const messages = [
      {
        id: "old",
        role: "assistant",
        parts: [{ type: "tool-invocation", toolName: "bash", toolState: "success" }],
      },
      {
        id: "prompt",
        role: "user",
        parts: [{ type: "tool-invocation", toolName: "bash", toolState: "pending" }],
      },
      {
        id: "new",
        role: "assistant",
        parts: [
          { type: "text", content: "IDLEQA-BG-1" },
          { type: "tool-invocation", toolName: "bash", toolState: "pending", toolOutput: "secret" },
          { type: "subagent", toolState: "success", subagentPrompt: "secret" },
        ],
      },
    ];
    expect(freshToolStates(messages, new Set(["old"]))).toEqual([
      "bash:pending",
      "subagent:success",
    ]);
    expect(selectedCases("async-question")).toEqual(["async-question"]);
  });

  test("invalidation deltas count one provider's causes and environment-wide ones", () => {
    const before = {
      codex: { "discovery-renewal": 2, "content-revision": 1 },
      claude: { "projection-read": 5 },
      environment: { "model-catalog-refresh": 1 },
    };
    const after = {
      codex: { "discovery-renewal": 6, "content-revision": 1, "projection-read": 3 },
      claude: { "projection-read": 9 },
      environment: { "model-catalog-refresh": 2 },
    };
    expect(invalidationCauseDelta(before, after, "codex")).toEqual({
      "discovery-renewal": 4,
      "projection-read": 3,
      "environment:model-catalog-refresh": 1,
      total: 8,
    });
    // An older backend reports no counters: nothing moved.
    expect(invalidationCauseDelta(undefined, undefined, "codex")).toEqual({ total: 0 });
  });

  test("discovery renewal deltas name the section and the changed paths that moved", () => {
    const before = {
      codex: { runtime: { count: 1, changed: { "summary.notices[count]": 1 } } },
      claude: { mcp: { count: 2, changed: { "value[count]": 2 } } },
    };
    const after = {
      codex: {
        runtime: {
          count: 4,
          changed: { "summary.notices[count]": 1, "summary.notices[].occurrences[count]": 3 },
        },
        models: { count: 1, changed: { "value[order]": 1 } },
        mcp: { count: 0, changed: {} },
      },
      claude: { mcp: { count: 3, changed: { "value[count]": 3 } } },
    };
    expect(discoveryRenewalDelta(before, after, "codex")).toEqual({
      runtime: { count: 3, changed: { "summary.notices[].occurrences[count]": 3 } },
      models: { count: 1, changed: { "value[order]": 1 } },
    });
    expect(discoveryRenewalDelta(undefined, undefined, "codex")).toEqual({});
  });

  test("read cadence counts reads and the largest gap inside the window", () => {
    expect(readGaps([0, 1_500, 4_500])).toEqual([1_500, 3_000]);
    const cadence = readCadence([0, 10_000, 25_000, 40_000, 70_000], 5_000, 65_000);
    expect(cadence).toEqual({ reads: 3, perMinute: 3, maxGapMs: 15_000 });
    expect(readCadence([], 0, 60_000)).toEqual({
      reads: 0,
      perMinute: 0,
      maxGapMs: null,
    });
  });

  test("read gaps are bucketed so one tick's burst reads apart from backoff steps", () => {
    expect(gapHistogram([0, 100, 1_600, 4_600, 14_600, 29_600, 99_000], 0, 30_000)).toEqual({
      "<250ms": 1,
      "250ms-2s": 1,
      "2-6s": 1,
      "6-12s": 1,
      ">=12s": 1,
    });
  });

  test("the sidebar marker's data-state maps to its activity state", () => {
    expect(sidebarActivityFromMarkerState("working")).toBe("working");
    expect(sidebarActivityFromMarkerState("waiting")).toBe("waiting");
    expect(sidebarActivityFromMarkerState("idle")).toBe("idle");
    expect(sidebarActivityFromMarkerState("inactive")).toBe("stopped");
    expect(sidebarActivityFromMarkerState(null)).toBe("unknown");
    expect(sidebarActivityFromMarkerState(undefined)).toBe("unknown");
    // Colour classes and unrecognised states are not activity states.
    expect(sidebarActivityFromMarkerState("bg-red-500/50 animate-pulse")).toBe("unknown");
    expect(sidebarActivityFromMarkerState("stopped")).toBe("unknown");
  });

  test("the fault seam never drops transport control frames", () => {
    expect(droppableGatewayEvent("native-agent-session-activity")).toBe(true);
    expect(droppableGatewayEvent("gateway.cursor")).toBe(false);
    expect(droppableGatewayEvent("gateway.reconcile-required")).toBe(false);
    expect(droppableGatewayEvent("native-event-stream-connected")).toBe(false);
    expect(droppableGatewayEvent("")).toBe(false);
  });

  test("background evidence excludes prompts, tool arguments, old results and assistant prose", () => {
    const marker = "IDLEQA-BGOUT-123456";
    const prompt = `Start a background task: sleep 20; echo ${marker}`;
    const messages = [
      {
        id: "prompt",
        role: "user",
        content: prompt,
        parts: [{ type: "tool-invocation", toolOutput: marker }],
      },
      { id: "old", role: "assistant", parts: [{ type: "tool-invocation", toolOutput: marker }] },
      {
        id: "call",
        role: "assistant",
        parts: [
          { type: "tool-invocation", toolArgs: { command: prompt }, content: prompt },
          { type: "text", content: marker },
        ],
      },
    ];
    const previous = new Set(["old"]);
    expect(
      freshToolResults(messages, previous).some((result) =>
        shellOutputContainsMarker(result.toolOutput, marker),
      ),
    ).toBe(false);
    const result = {
      id: "result",
      role: "assistant",
      parts: [
        {
          type: "task-group",
          task: { type: "tool-invocation", detailRef: "detail-1" },
          childTools: [{ type: "tool-invocation", toolOutput: `stdout:\n${marker}\r\n` }],
        },
      ],
    };
    expect(freshToolResults([result], previous)).toEqual([
      { detailRef: "detail-1" },
      { toolOutput: `stdout:\n${marker}\r\n` },
    ]);
    expect(
      freshToolResults([result], previous).some((entry) =>
        shellOutputContainsMarker(entry.toolOutput, marker),
      ),
    ).toBe(true);
    expect(shellOutputContainsMarker(`echo ${marker}`, marker)).toBe(false);
    expect(shellOutputContainsMarker(prompt, marker)).toBe(false);
  });

  test("only failed cases fail a provider", () => {
    expect(
      failedCases({
        hidden: { status: "passed", notes: [], timings: {} },
        subagents: { status: "not-exercised", notes: [], timings: {} },
        approval: {
          status: "failed",
          notes: [],
          timings: {},
          error: "no card",
        },
      }),
    ).toEqual(["approval: no card"]);
  });

  test("only completed tasks started after the snapshot offer an output file", () => {
    const tasks = [
      { id: "old", status: "completed", outputFile: "/tmp/old.output" },
      { id: "running", status: "running", outputFile: "/tmp/running.output" },
      { id: "done", status: "completed", outputFile: "/tmp/done.output" },
      { id: "failed", status: "failed", outputFile: "/tmp/failed.output" },
      { id: "no-file", status: "completed" },
    ];
    expect(completedTaskOutputFiles(tasks, new Set(["old"]))).toEqual(["/tmp/done.output"]);
    expect(completedTaskOutputFiles(undefined, new Set())).toEqual([]);
  });

  test("background output evidence prefers a tool result, then a task output file", () => {
    const files: Record<string, string> = {
      "/tmp/a.output": "IDLEQA-BGOUT-1 is the marker\n",
      "/tmp/b.output": "started\nIDLEQA-BGOUT-1\n",
    };
    const read = (file: string) => files[file];
    expect(backgroundOutputEvidence(true, [], read, "IDLEQA-BGOUT-1")).toBe("tool-result");
    // A line merely mentioning the marker (an echoed command) is not output.
    expect(backgroundOutputEvidence(false, ["/tmp/a.output"], read, "IDLEQA-BGOUT-1")).toBe("none");
    expect(
      backgroundOutputEvidence(false, ["/tmp/a.output", "/tmp/b.output"], read, "IDLEQA-BGOUT-1"),
    ).toBe("output-file");
    // An unreadable file is no evidence.
    expect(backgroundOutputEvidence(false, ["/tmp/missing"], read, "IDLEQA-BGOUT-1")).toBe("none");
  });
});

test("restart qualification rejects a lost stream despite fallback turn completion", () => {
  expect(() => requireRecoveredBackoff(null)).toThrow("did not recover backoff");
  expect(requireRecoveredBackoff(0)).toBe(0);
  expect(requireRecoveredBackoff(12000)).toBe(12000);
});

test("fake Pi overrides cannot escape loopback and real runs preserve overrides", () => {
  expect(idleObservationModel("pi", true, "openai/real")).toBe("idleqa-fake/idleqa-1");
  expect(idleObservationModel("pi", true)).toBe("idleqa-fake/idleqa-1");
  expect(idleObservationModel("pi", false, "openai/real")).toBe("openai/real");
  expect(idleObservationModel("codex", true, "custom")).toBe("custom");
});
test("async question prompt requests both replies the watcher expects", () => {
  const prompt = asyncQuestionPrompt("Choose a codeword", "IDLEQA-ASKED-1");
  expect(prompt).toContain("reply with exactly IDLEQA-ASKED-1 and nothing else");
  expect(prompt).toContain("After I answer, reply with exactly CODEWORD_CHOSEN=<selected option>");
  expect(scriptedStep(prompt, false).kind).toBe("question");
  expect(finalReply(prompt)).toBe("IDLEQA-ASKED-1");
  expect(finalReply("Answers to your questions:\n- Choose a codeword?: IDLEQA_BETA")).toBe(
    "CODEWORD_CHOSEN=IDLEQA_BETA",
  );
});
