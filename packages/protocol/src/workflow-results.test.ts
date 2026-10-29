import { describe, expect, test } from "bun:test";
import { graphOutputPortProblem, graphOutputToolPort } from "./graphs/output-slots.js";
import {
  SYSTEM_INSTRUCTIONS_FRAME_CLOSE,
  SYSTEM_INSTRUCTIONS_FRAME_OPEN,
} from "./review-evidence-frames.js";
import {
  DEFAULT_WORKFLOW_RESULT_TOOLS_SETTINGS,
  QUALIFIED_WORKFLOW_RESULT_TOOL_PROVIDERS,
  WORKFLOW_RESULT_KINDS,
  isWorkflowResultKind,
  isWorkflowResultSubmissionState,
  normalizeWorkflowResultToolsSettings,
  workflowResultInstruction,
  parseWorkflowResultTurn,
  workflowResultTurnToolNames,
  callsOwnWorkflowResult,
  GRAPH_ACTIVATION_EXTRA_TOOLS,
  isWorkflowResultAttemptTool,
  WORKFLOW_RESULT_TURN_MAX_SLOTS,
  workflowResultTurnAllows,
  workflowResultTurnToolPort,
  workflowResultNoun,
  workflowResultSubmissionLabel,
  workflowResultToolName,
  type WorkflowResultSubmissionState,
} from "./workflow-results.js";

describe("workflow result contracts", () => {
  test("every kind has a distinct submission tool name", () => {
    const names = WORKFLOW_RESULT_KINDS.map(workflowResultToolName);
    expect(new Set(names).size).toBe(WORKFLOW_RESULT_KINDS.length);
    expect(names.every((name) => /^submit_[a-z_]+$/.test(name))).toBe(true);
  });

  test("kind guard rejects near-misses and non-strings", () => {
    expect(isWorkflowResultKind("review-report")).toBe(true);
    expect(isWorkflowResultKind("review_report")).toBe(false);
    expect(isWorkflowResultKind("")).toBe(false);
    expect(isWorkflowResultKind(null)).toBe(false);
    expect(isWorkflowResultKind({ toString: () => "review-report" })).toBe(false);
  });

  test("the instruction supersedes final-JSON guidance and names the tool and key", () => {
    const resultKey = "3f1b2c4d-0000-4000-8000-000000000000";
    const instruction = workflowResultInstruction("review-report", resultKey);
    expect(instruction).toContain("submit_review_report");
    expect(instruction).toContain(JSON.stringify(resultKey));
    expect(instruction).toContain("replace any earlier instruction to emit final JSON");
    expect(instruction).toContain("get_workflow_result_status");
    expect(instruction).toContain("validate_workflow_result");
    expect(instruction).toContain("Never call the submission tool with a probe");
    expect(instruction).toContain("arguments` as a raw object");
    // A model that emits malformed arguments must retry the call rather than
    // conclude the tool is broken.
    expect(instruction).toContain("balanced braces and brackets");
    expect(instruction).toContain("not a sign that the tool is broken");
    // The observed fault is an extra trailing brace, and a rejection must not
    // read as a size or formatting problem that invites shrinking the report.
    expect(instruction).toContain("one extra `}`");
    expect(instruction).toContain("not a size, line-length or formatting problem");
    expect(instruction).toContain("Never shorten the report");
    expect(instruction).not.toContain("every brace and bracket closed");
    // A validated payload is committed by digest rather than re-sent.
    expect(instruction).toContain("`validatedDigest`");
    expect(instruction).toContain("Only retry an accepted submission with the exact same payload");
    expect(instruction).toContain("Do not print the result as JSON in your final response.");
    // Acceptance must not read as workflow completion.
    expect(instruction).toContain("The backend decides when the workflow advances.");
    expect(instruction.startsWith(SYSTEM_INSTRUCTIONS_FRAME_OPEN)).toBe(true);
    expect(instruction.endsWith(SYSTEM_INSTRUCTIONS_FRAME_CLOSE)).toBe(true);
  });

  test("the instruction carries no credential material", () => {
    const instruction = workflowResultInstruction("fix-result", crypto.randomUUID());
    expect(instruction).not.toContain("token");
    expect(instruction).not.toContain("Bearer");
    expect(instruction).not.toContain("http");
  });

  test("a broker instruction carries its attempt capability inside the system frame", () => {
    const capability = "signed-attempt-capability";
    const instruction = workflowResultInstruction("fix-result", crypto.randomUUID(), {
      capability,
    });
    expect(instruction).toContain(`capability ${JSON.stringify(capability)}`);
    expect(instruction.startsWith(SYSTEM_INSTRUCTIONS_FRAME_OPEN)).toBe(true);
    expect(instruction.endsWith(SYSTEM_INSTRUCTIONS_FRAME_CLOSE)).toBe(true);
  });

  test("submission state guard accepts only the four projected states", () => {
    const states: WorkflowResultSubmissionState[] = [
      "preparing",
      "correcting",
      "received",
      "needs-attention",
    ];
    expect(states.every(isWorkflowResultSubmissionState)).toBe(true);
    expect(isWorkflowResultSubmissionState("accepted")).toBe(false);
    expect(isWorkflowResultSubmissionState(undefined)).toBe(false);
  });

  test("status text uses the domain noun and never claims a passing outcome", () => {
    expect(workflowResultNoun("feature-plan-state")).toBe("plan");
    expect(workflowResultNoun("review-report")).toBe("report");
    expect(workflowResultNoun("verification-result")).toBe("result");
    expect(workflowResultSubmissionLabel("preparing", "review-report")).toBe("Preparing report");
    expect(workflowResultSubmissionLabel("correcting", "review-report")).toBe(
      "Correcting report format",
    );
    expect(workflowResultSubmissionLabel("received", "review-report")).toBe(
      "Report received; finishing checks",
    );
    expect(workflowResultSubmissionLabel("needs-attention", "review-report")).toBe(
      "Report needs attention",
    );
    for (const kind of WORKFLOW_RESULT_KINDS) {
      for (const state of ["preparing", "correcting", "received", "needs-attention"] as const) {
        const label = workflowResultSubmissionLabel(state, kind);
        expect(label).not.toContain("passed");
        expect(label).not.toContain("complete");
        expect(label.length).toBeLessThan(64);
      }
    }
  });
});

describe("workflow result rollout settings", () => {
  test("defaults admit only the qualified providers and every kind", () => {
    expect(DEFAULT_WORKFLOW_RESULT_TOOLS_SETTINGS.enabled).toBe(true);
    expect(DEFAULT_WORKFLOW_RESULT_TOOLS_SETTINGS.providers).toEqual([
      ...QUALIFIED_WORKFLOW_RESULT_TOOL_PROVIDERS,
    ]);
    expect(DEFAULT_WORKFLOW_RESULT_TOOLS_SETTINGS.kinds).toEqual([...WORKFLOW_RESULT_KINDS]);
  });

  test("a malformed stored value falls back to the qualified defaults", () => {
    for (const value of [undefined, null, "enabled", 3, [], { providers: "claude" }]) {
      expect(normalizeWorkflowResultToolsSettings(value)).toEqual(
        DEFAULT_WORKFLOW_RESULT_TOOLS_SETTINGS,
      );
    }
  });

  test("unknown providers and kinds are dropped rather than widening admission", () => {
    const settings = normalizeWorkflowResultToolsSettings({
      enabled: true,
      providers: ["codex", "wat", "opencode"],
      kinds: ["review-report", "not-a-kind"],
    });
    expect(settings.providers).toEqual(["codex", "opencode"]);
    expect(settings.kinds).toEqual(["review-report"]);
  });

  test("an explicitly empty list closes admission instead of restoring defaults", () => {
    expect(normalizeWorkflowResultToolsSettings({ providers: [], kinds: [] })).toEqual({
      enabled: true,
      providers: [],
      kinds: [],
    });
  });

  test("the master switch is honoured and non-boolean values default to enabled", () => {
    expect(normalizeWorkflowResultToolsSettings({ enabled: false }).enabled).toBe(false);
    expect(normalizeWorkflowResultToolsSettings({ enabled: "no" }).enabled).toBe(true);
  });
});

describe("provisional findings in the reviewer instruction", () => {
  test("a live reviewer is encouraged, not required, to report findings as it goes", () => {
    const resultKey = crypto.randomUUID();
    const instruction = workflowResultInstruction("review-report", resultKey, {
      provisionalFindings: true,
    });
    expect(instruction).toContain("`report_finding`");
    expect(instruction).toContain("encouraged, but not required");
    // The report stays the source of truth and must repeat every finding.
    expect(instruction).toContain("must still list every finding");
    expect(instruction).toContain(JSON.stringify(resultKey));
  });

  test("other attempts, and reviewers whose owner takes no findings, are not told about it", () => {
    const resultKey = crypto.randomUUID();
    expect(workflowResultInstruction("review-report", resultKey)).not.toContain("report_finding");
    expect(
      workflowResultInstruction("fix-result", resultKey, { provisionalFindings: true }),
    ).not.toContain("report_finding");
  });
});

describe("a turn's declared workflow-result attempt", () => {
  const resultKey = "11111111-1111-4111-8111-111111111111";

  test("both fields absent is an ordinary turn; one without the other is malformed", () => {
    expect(parseWorkflowResultTurn(undefined, undefined)).toEqual({ ok: true });
    expect(parseWorkflowResultTurn("submit_review_report", resultKey)).toEqual({
      ok: true,
      turn: { tool: "submit_review_report", resultKey },
    });
    for (const [tool, key] of [
      ["submit_review_report", undefined],
      [undefined, resultKey],
      ["send_message", resultKey],
      ["submit_review_report", ""],
      ["submit_review_report", "a key"],
      ["submit_review_report", "k".repeat(129)],
      ["submit_review_report", 42],
    ]) {
      expect(parseWorkflowResultTurn(tool, key).ok).toBe(false);
    }
  });

  test("names the attempt's own tools, with report_finding for a reviewer only", () => {
    expect(workflowResultTurnToolNames({ tool: "submit_review_report", resultKey })).toEqual([
      "submit_review_report",
      "validate_workflow_result",
      "get_workflow_result_status",
      "report_finding",
    ]);
    expect(workflowResultTurnToolNames({ tool: "submit_fix_result", resultKey })).not.toContain(
      "report_finding",
    );
  });

  test("a call is the attempt's own only when its arguments name the attempt's key", () => {
    const turn = { tool: "submit_review_report", resultKey };
    expect(callsOwnWorkflowResult(turn, { resultKey, result: {} })).toBe(true);
    for (const args of [{ resultKey: "other" }, {}, undefined, [resultKey], resultKey]) {
      expect(callsOwnWorkflowResult(turn, args)).toBe(false);
    }
  });
});

describe("a graph activation turn's result slots", () => {
  const keyA = "graph-activation-a";
  const keyB = "graph-activation-b";
  const slots = [
    { tool: "submit_brief", resultKey: keyA },
    { tool: "submit_risks", resultKey: keyB },
  ];

  test("accepts per-port tools, slots and extra tools", () => {
    expect(parseWorkflowResultTurn("submit_brief", keyA)).toEqual({
      ok: true,
      turn: { tool: "submit_brief", resultKey: keyA },
    });
    expect(
      parseWorkflowResultTurn("submit_brief", keyA, slots, ["read_artifact", "report_progress"]),
    ).toEqual({
      ok: true,
      turn: {
        tool: "submit_brief",
        resultKey: keyA,
        slots,
        extraTools: ["read_artifact", "report_progress"],
      },
    });
    // OpenCode: every slot uses the shared graph-output tool.
    expect(
      parseWorkflowResultTurn("submit_graph_output", keyA, [
        { tool: "submit_graph_output", resultKey: keyA },
        { tool: "submit_graph_output", resultKey: keyB },
      ]).ok,
    ).toBe(true);
    expect(parseWorkflowResultTurn("submit_brief", keyA, undefined, []).ok).toBe(true);
    const many = Array.from({ length: WORKFLOW_RESULT_TURN_MAX_SLOTS }, (_, index) => ({
      tool: `submit_port${index}`,
      resultKey: `key-${index}`,
    }));
    expect(parseWorkflowResultTurn("submit_port0", "key-0", many).ok).toBe(true);
  });

  test("refuses malformed slots and extra tools", () => {
    const refused: [unknown, unknown, unknown, unknown][] = [
      [undefined, undefined, slots, undefined],
      [undefined, undefined, undefined, ["read_artifact"]],
      ["submit_Brief", keyA, undefined, undefined],
      ["submit_workflow_result", keyA, undefined, undefined],
      [`submit_${"p".repeat(49)}`, keyA, undefined, undefined],
      ["submit_brief", keyA, [], undefined],
      ["submit_brief", keyA, {}, undefined],
      ["submit_brief", keyA, [slots[1], slots[0]], undefined],
      ["submit_brief", keyA, [slots[0], { tool: "submit_risks", resultKey: keyA }], undefined],
      ["submit_brief", keyA, [slots[0], { tool: "submit_brief", resultKey: keyB }], undefined],
      ["submit_brief", keyA, [slots[0], { tool: "send_message", resultKey: keyB }], undefined],
      ["submit_brief", keyA, [slots[0], { tool: "submit_risks", resultKey: "a b" }], undefined],
      ["submit_brief", keyA, [slots[0], null], undefined],
      [
        "submit_port0",
        "key-0",
        Array.from({ length: WORKFLOW_RESULT_TURN_MAX_SLOTS + 1 }, (_, index) => ({
          tool: `submit_port${index}`,
          resultKey: `key-${index}`,
        })),
        undefined,
      ],
      ["submit_brief", keyA, slots, ["send_message"]],
      ["submit_brief", keyA, slots, ["ask_human", "ask_human"]],
      ["submit_brief", keyA, slots, "ask_human"],
      ["submit_brief", keyA, slots, [42]],
    ];
    for (const [tool, key, turnSlots, extraTools] of refused) {
      expect(parseWorkflowResultTurn(tool, key, turnSlots, extraTools).ok).toBe(false);
    }
  });

  test("names each slot's own tools, status and the listed extra tools", () => {
    expect(
      workflowResultTurnToolNames({
        tool: "submit_brief",
        resultKey: keyA,
        slots,
        extraTools: ["ask_human"],
      }),
    ).toEqual([
      "submit_brief",
      "validate_brief",
      "submit_risks",
      "validate_risks",
      "get_workflow_result_status",
      "ask_human",
    ]);
    expect(
      workflowResultTurnToolNames({
        tool: "submit_graph_output",
        resultKey: keyA,
        slots: [
          { tool: "submit_graph_output", resultKey: keyA },
          { tool: "submit_graph_output", resultKey: keyB },
        ],
      }),
    ).toEqual(["submit_graph_output", "validate_workflow_result", "get_workflow_result_status"]);
  });

  test("lets a call through only with its own slot's key", () => {
    const turn = { tool: "submit_brief", resultKey: keyA, slots, extraTools: ["read_artifact"] };
    expect(workflowResultTurnAllows(turn, "submit_brief", { resultKey: keyA })).toBe(true);
    expect(workflowResultTurnAllows(turn, "validate_brief", { resultKey: keyA })).toBe(true);
    expect(workflowResultTurnAllows(turn, "submit_risks", { resultKey: keyB })).toBe(true);
    expect(workflowResultTurnAllows(turn, "submit_brief", { resultKey: keyB })).toBe(false);
    expect(workflowResultTurnAllows(turn, "validate_risks", { resultKey: keyA })).toBe(false);
    expect(workflowResultTurnAllows(turn, "validate_workflow_result", { resultKey: keyA })).toBe(
      false,
    );
    for (const key of [keyA, keyB]) {
      expect(workflowResultTurnAllows(turn, "get_workflow_result_status", { resultKey: key })).toBe(
        true,
      );
    }
    expect(workflowResultTurnAllows(turn, "get_workflow_result_status", { resultKey: "x" })).toBe(
      false,
    );
    expect(workflowResultTurnAllows(turn, "read_artifact", { id: "artifact" })).toBe(true);
    expect(workflowResultTurnAllows(turn, "read_artifact", undefined)).toBe(true);
    expect(workflowResultTurnAllows(turn, "ask_human", { question: "?" })).toBe(false);
    expect(workflowResultTurnAllows(turn, "report_progress", { resultKey: keyA })).toBe(false);
    expect(workflowResultTurnAllows(turn, "report_finding", { resultKey: keyA })).toBe(false);
    expect(workflowResultTurnAllows(turn, "send_message", { resultKey: keyA })).toBe(false);
    const progress = { ...turn, extraTools: ["report_progress", "ask_human"] };
    expect(workflowResultTurnAllows(progress, "report_progress", { resultKey: keyB })).toBe(true);
    expect(workflowResultTurnAllows(progress, "report_progress", {})).toBe(false);
    expect(workflowResultTurnAllows(progress, "ask_human", {})).toBe(true);
    expect(workflowResultTurnAllows(progress, "read_artifact", {})).toBe(false);
  });

  test("an old kind-tool turn allows what it always did", () => {
    const resultKey = "11111111-1111-4111-8111-111111111111";
    const turn = { tool: "submit_review_report", resultKey };
    for (const tool of workflowResultTurnToolNames(turn)) {
      expect(workflowResultTurnAllows(turn, tool, { resultKey })).toBe(
        callsOwnWorkflowResult(turn, { resultKey }),
      );
      expect(workflowResultTurnAllows(turn, tool, { resultKey: "other" })).toBe(false);
    }
    expect(workflowResultTurnAllows(turn, "read_artifact", { resultKey })).toBe(false);
    expect(GRAPH_ACTIVATION_EXTRA_TOOLS).toEqual(["report_progress", "read_artifact", "ask_human"]);
  });

  test("knows every attempt's tools and nothing else", () => {
    for (const name of [
      "submit_review_report",
      "submit_graph_output",
      "validate_workflow_result",
      "get_workflow_result_status",
      "report_finding",
      "report_progress",
      "read_artifact",
      "ask_human",
      "submit_brief",
      "validate_brief",
    ]) {
      expect(isWorkflowResultAttemptTool(name)).toBe(true);
    }
    for (const name of [
      "send_message",
      "get_artifact",
      "validate_Brief",
      "validate_review_report",
      "submit_workflow_result",
      "submit_",
      "validate_",
    ]) {
      expect(isWorkflowResultAttemptTool(name)).toBe(false);
    }
  });

  test("the local port grammar agrees with the graph output tool grammar", () => {
    const ports = [
      "brief",
      "risks_2",
      "aB9_x",
      "a",
      "p".repeat(48),
      "p".repeat(49),
      "Brief",
      "_brief",
      "9brief",
      "brief-x",
      "brief x",
      "",
      "review_report",
      "graph_output",
      "workflow_result",
      "fix_result",
      "feature_plan_state",
      "review_preparation_x",
    ];
    for (const port of ports) {
      const tool = `submit_${port}`;
      expect(workflowResultTurnToolPort(tool)).toBe(graphOutputToolPort(tool));
      expect(workflowResultTurnToolPort(tool) === port).toBe(graphOutputPortProblem(port) === null);
    }
    for (const name of ["validate_brief", "brief", undefined, 42, "submit_"]) {
      expect(workflowResultTurnToolPort(name)).toBe(graphOutputToolPort(name));
    }
  });
});
