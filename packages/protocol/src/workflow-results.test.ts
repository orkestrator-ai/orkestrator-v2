import { describe, expect, test } from "bun:test";
import {
  DEFAULT_WORKFLOW_RESULT_TOOLS_SETTINGS,
  QUALIFIED_WORKFLOW_RESULT_TOOL_PROVIDERS,
  WORKFLOW_RESULT_KINDS,
  isWorkflowResultKind,
  isWorkflowResultSubmissionState,
  normalizeWorkflowResultToolsSettings,
  workflowResultInstruction,
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
    expect(instruction).toContain("Do not print the result as JSON in your final response.");
    // Acceptance must not read as workflow completion.
    expect(instruction).toContain("The backend decides when the workflow advances.");
  });

  test("the instruction carries no credential material", () => {
    const instruction = workflowResultInstruction("fix-result", crypto.randomUUID());
    expect(instruction).not.toContain("token");
    expect(instruction).not.toContain("Bearer");
    expect(instruction).not.toContain("http");
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
