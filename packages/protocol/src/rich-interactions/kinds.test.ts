import { describe, expect, test } from "bun:test";
import { RICH_KIND_FIXTURES } from "../testing/rich-interaction-fixtures.js";
import { RICH_KIND_MODULES, type RichInteractionKind } from "./core.js";
import { initialFormValues, pruneHiddenValues, readFormSpec, readFormValues } from "./form.js";
import type { RichActionDef } from "./kind-module.js";
import { documentBlockHash, type DocumentSpec } from "./kinds-feedback.js";
import { criterionHash, currentAssessment, type CriteriaSpec } from "./kinds-operations.js";
import { chartSelectionMembers, type ChartSelectionSpec } from "./kinds-results.js";
import { applyPlanChanges, compareCollectionCells, planDependencyProblems, type PlanSpec } from "./kinds-decisions.js";
import { validated } from "./validate.js";

const spec = (kind: RichInteractionKind, override?: unknown) =>
  RICH_KIND_MODULES[kind].readSpec(override ?? RICH_KIND_FIXTURES[kind].spec, "$.spec");
const action = (kind: RichInteractionKind, actionId: string): RichActionDef =>
  RICH_KIND_MODULES[kind].actions.find((a) => a.id === actionId) ?? { id: actionId, label: actionId, route: "agent-followup", effect: "followup" };
const result = (kind: RichInteractionKind, actionId: string, value: unknown, specValue?: unknown) =>
  validated(() => RICH_KIND_MODULES[kind].readResult(spec(kind, specValue), action(kind, actionId), value, "$.result"));

describe("01 choice", () => {
  test("a single-answer question refuses two options; another answer is allowed", () => {
    expect(result("choice", "submit", { answers: [{ questionId: "findings-layout", optionIds: ["focused-list", "board"] }] }).ok).toBe(false);
    expect(result("choice", "submit", { answers: [{ questionId: "findings-layout", optionIds: [], other: "Mix both" }] }).ok).toBe(true);
  });
  test("a recommendation needs its rationale", () => {
    const fixture = structuredClone(RICH_KIND_FIXTURES.choice.spec) as { questions: Array<Record<string, unknown>> };
    delete fixture.questions[0]!.recommendationRationale;
    expect(validated(() => spec("choice", fixture)).ok).toBe(false);
  });
});

describe("02 form", () => {
  const form = readFormSpec(
    {
      fields: [
        { id: "count", type: "number", label: "Count", required: true, minimum: 0, step: 2, nullable: true },
        { id: "on", type: "boolean", label: "On", required: true },
        { id: "name", type: "text", label: "Name", required: true, visibleWhen: { fieldId: "on", equals: true } },
        { id: "when", type: "date", mode: "local-datetime", label: "When", required: false },
        { id: "items", type: "repeat", label: "Items", required: false, fields: [{ id: "path", type: "file", label: "Path", required: true }] },
      ],
    },
    "$",
  );
  test("zero, false, null and absent stay distinct", () => {
    expect(readFormValues(form, { count: 0, on: false }, "$")).toEqual({ count: 0, on: false });
    expect(readFormValues(form, { count: null, on: false }, "$")).toEqual({ count: null, on: false });
  });
  test("hidden fields must be omitted; visible required fields must be present", () => {
    expect(validated(() => readFormValues(form, { count: 2, on: false, name: "x" }, "$")).ok).toBe(false);
    expect(validated(() => readFormValues(form, { count: 2, on: true }, "$")).ok).toBe(false);
    expect(pruneHiddenValues(form.fields, { count: 2, on: false, name: "x" })).toEqual({ values: { count: 2, on: false }, removed: ["Name"] });
  });
  test("steps, time zones, repeat item identity and secrets", () => {
    expect(validated(() => readFormValues(form, { count: 3, on: false }, "$")).ok).toBe(false);
    expect(validated(() => readFormValues(form, { count: 2, on: false, when: { dateTime: "2026-11-20T10:00", timeZone: "Europe/London" } }, "$")).ok).toBe(true);
    expect(validated(() => readFormValues(form, { count: 2, on: false, items: [{ itemId: "a", values: { path: "x" } }, { itemId: "a", values: { path: "y" } }] }, "$")).ok).toBe(false);
    expect(validated(() => readFormSpec({ fields: [{ id: "k", type: "text", label: "Key", secret: true }] }, "$")).ok).toBe(false);
  });
  test("defaults are the only initial values", () => {
    const fixture = (RICH_KIND_FIXTURES.form.spec as { form: unknown }).form;
    expect(initialFormValues(readFormSpec(fixture, "$").fields)).toEqual({ concurrency: 4 });
  });
});

describe("03 plan", () => {
  const plan = spec("plan") as PlanSpec;
  test("excluding a prerequisite of an included step is explained at accept-scope", () => {
    const outcome = result("plan", "accept-scope", { baseRevision: 1, changes: [{ op: "setIncluded", stepId: "recovery-tests", value: false }] });
    expect(outcome).toMatchObject({ ok: false });
    expect(!outcome.ok && outcome.error).toContain("release depends on excluded step recovery-tests");
  });
  test("reordering keeps step identity", () => {
    const next = applyPlanChanges(plan, [{ op: "moveBefore", stepId: "recovery-tests", beforeStepId: "schema" }]);
    expect(next.steps.map((s) => s.id)).toEqual(["recovery-tests", "schema", "historical-migration", "release"]);
    expect(planDependencyProblems(next.steps)).toEqual([]);
  });
  test("cycles are refused", () => {
    const cyclic = structuredClone(RICH_KIND_FIXTURES.plan.spec) as { steps: Array<{ id: string; dependsOn: string[] }> };
    cyclic.steps[0]!.dependsOn = ["release"];
    expect(validated(() => spec("plan", cyclic)).ok).toBe(false);
  });
});

describe("04 collection", () => {
  test("partial collections cannot select unseen records", () => {
    const partial = { ...(RICH_KIND_FIXTURES.collection.spec as object), complete: false, totalRows: 10 };
    expect(result("collection", "discuss-selected", { sourceRevision: 3, selection: { mode: "all-records" } }, partial).ok).toBe(false);
    expect(result("collection", "discuss-selected", { sourceRevision: 3, selection: { mode: "all-records" } }).ok).toBe(true);
  });
  test("a stale source revision and non-editable edits are refused", () => {
    expect(result("collection", "x", { sourceRevision: 2, selection: { mode: "explicit", rowIds: ["finding-02"] } }).ok).toBe(false);
    expect(result("collection", "x", { sourceRevision: 3, selection: { mode: "explicit", rowIds: ["finding-02"] }, edits: [{ rowId: "finding-02", field: "severity", value: 1 }] }).ok).toBe(false);
  });
  test("sorting follows declared types, nulls last", () => {
    expect([10, null, 9].sort((a, b) => compareCollectionCells("number", a, b))).toEqual([9, 10, null]);
    expect(["10", "9"].sort((a, b) => compareCollectionCells("text", a, b))).toEqual(["10", "9"]);
  });
});

describe("05 code review", () => {
  test("line anchors must name lines shown on the chosen side", () => {
    const base = { itemId: "i", file: "apps/backend/src/session.ts", scope: "lines", hunkId: "h1", disposition: "revise", comment: "x" };
    expect(result("code-review", "send-review", { items: [{ ...base, side: "before", startLine: 41, endLine: 41 }] }).ok).toBe(true);
    expect(result("code-review", "send-review", { items: [{ ...base, side: "before", startLine: 42, endLine: 42 }] }).ok).toBe(false);
  });
  test("trimmed hunks refuse line comments", () => {
    const trimmed = structuredClone(RICH_KIND_FIXTURES["code-review"].spec) as { files: Array<{ hunks: Array<Record<string, unknown>> }> };
    trimmed.files[0]!.hunks[0]!.trimmed = true;
    expect(result("code-review", "send-review", RICH_KIND_FIXTURES["code-review"].result, trimmed).ok).toBe(false);
  });
});

describe("06 feedback threads", () => {
  test("agents may only append agent replies", () => {
    const module = RICH_KIND_MODULES.feedback;
    const previous = module.applyRevision!(spec("feedback"), { body: "Why?" }, action("feedback", "discuss"), { now: "t", actionRecordId: "rr_1" })!;
    const reply = { ...previous, entries: [...previous.entries, { entryId: "a1", author: "agent", body: "Because", createdAt: "t2" }] };
    expect(module.mergeAgentUpdate!(previous, reply, "$").entries).toHaveLength(2);
    const forged = { ...previous, entries: [{ ...previous.entries[0], body: "edited" }] };
    expect(validated(() => module.mergeAgentUpdate!(previous, forged, "$")).ok).toBe(false);
  });
});

describe("07 result review", () => {
  test("a newer result revision invalidates the decision", () => {
    expect(result("result-review", "accept", { expectedResultRevision: 4, decision: "accept" }).ok).toBe(false);
    expect(result("result-review", "accept", { expectedResultRevision: 5, decision: "accept" }).ok).toBe(true);
  });
  test("agents cannot claim observed provenance", () => {
    const forged = structuredClone(RICH_KIND_FIXTURES["result-review"].spec) as { checks: Array<Record<string, unknown>> };
    forged.checks[0]!.provenance = "orkestrator-observed";
    expect(validated(() => spec("result-review", forged)).ok).toBe(false);
  });
});

describe("08 document", () => {
  const doc = spec("document") as DocumentSpec;
  test("edits carry the block hash they were made on", () => {
    const block = doc.blocks[1]!;
    const replacement = { id: "recovery", type: "paragraph", text: "Retry only after checking the receipt." };
    expect(result("document", "save", { baseRevision: 1, ops: [{ op: "replace-block", blockId: "recovery", expectedBlockHash: documentBlockHash(block), replacement }] }).ok).toBe(true);
    expect(result("document", "save", { baseRevision: 1, ops: [{ op: "replace-block", blockId: "recovery", expectedBlockHash: "stale", replacement }] }).ok).toBe(false);
  });
  test("an agent update may not overwrite a preserved block", () => {
    const changed = { ...doc, blocks: doc.blocks.map((b) => (b.id === "compat" ? { ...b, text: "rewritten" } : b)) };
    expect(validated(() => RICH_KIND_MODULES.document.mergeAgentUpdate!(doc, changed, "$")).ok).toBe(false);
    const otherwise = { ...doc, blocks: doc.blocks.map((b) => (b.id === "recovery" ? { ...b, text: "better" } : b)) };
    expect(RICH_KIND_MODULES.document.mergeAgentUpdate!(doc, otherwise, "$").blocks[1]!.text).toBe("better");
  });
});

describe("09 diagnostics", () => {
  test("exact rerun is offered only for cases with a runner selector", () => {
    expect(result("diagnostics", "rerun-selection", { runRevision: 7, caseIds: ["auth:refresh-token"] }).ok).toBe(false);
    expect(result("diagnostics", "rerun-selection", { runRevision: 7, caseIds: ["auth:expired-session"] }).ok).toBe(true);
    expect(result("diagnostics", "request-fix", { runRevision: 6, caseIds: ["auth:expired-session"] }).ok).toBe(false);
  });
});

describe("10 chart selection", () => {
  const chart = spec("chart-selection") as ChartSelectionSpec;
  test("range inclusivity at exact boundaries; missing values stay members", () => {
    const base = { kind: "chart-range", seriesIds: ["build-duration"], from: 100, to: 120, population: "all-underlying-observations" } as const;
    expect(chartSelectionMembers(chart.chart, { ...base, inclusive: true })).toEqual(["build-duration#1", "build-duration#2", "build-duration#3"]);
    expect(chartSelectionMembers(chart.chart, { ...base, inclusive: false })).toEqual(["build-duration#2"]);
  });
  test("inverted ranges and unknown points are refused", () => {
    expect(result("chart-selection", "investigate-selection", { selection: { kind: "chart-range", seriesIds: ["build-duration"], from: 120, to: 100, inclusive: true, population: "visible-observations" } }).ok).toBe(false);
    expect(result("chart-selection", "investigate-selection", { selection: { kind: "chart-points", seriesIds: ["build-duration"], pointIds: ["build-duration#99"] } }).ok).toBe(false);
  });
});

describe("11 diagram", () => {
  test("Mermaid click directives are refused", () => {
    const withClick = { ...(RICH_KIND_FIXTURES.diagram.spec as object), mermaid: "flowchart LR\n a-->b\n click a callback" };
    expect(validated(() => spec("diagram", withClick)).ok).toBe(false);
  });
});

describe("12 widget result", () => {
  test("candidate values must match the declared output exactly", () => {
    expect(result("widget-result", "send-result", { candidateId: "c", candidateHash: "h", generation: "g", value: { workers: 4, memoryPerWorkerMiB: 1, extra: 1 } }).ok).toBe(false);
  });
});

describe("16 criteria", () => {
  test("human decisions are only recorded by the user and become historical when the criterion changes", () => {
    const module = RICH_KIND_MODULES.criteria;
    const agreed = module.applyRevision!(spec("criteria"), { edits: [], added: [], decisions: [] }, action("criteria", "agree"), { now: "t", actionRecordId: "rr_1" }) as CriteriaSpec;
    expect(agreed.phase).toBe("agreed");
    const reviewed = module.applyRevision!(agreed, { edits: [], added: [], decisions: [{ criterionId: "narrow", decision: "accepted", observations: [] }] }, action("criteria", "review"), { now: "t2", actionRecordId: "rr_2" }) as CriteriaSpec;
    expect(currentAssessment(reviewed, "narrow")?.decision).toBe("accepted");
    expect(validated(() => module.mergeAgentUpdate!(reviewed, { ...reviewed, assessments: { narrow: [] } }, "$")).ok).toBe(false);
    const changed = { ...reviewed, assessments: {}, criteria: reviewed.criteria.map((c) => (c.id === "narrow" ? { ...c, requirement: "Usable at 320px" } : c)) };
    const merged = module.mergeAgentUpdate!(reviewed, changed, "$") as CriteriaSpec;
    expect(currentAssessment(merged, "narrow")).toBeUndefined();
    expect(merged.assessments.narrow?.[0]?.historical).toBe(true);
    expect(criterionHash(merged.criteria[1]!)).toBe(criterionHash(reviewed.criteria[1]!));
  });
  test("a waiver needs a rationale", () => {
    const agreed = { ...(RICH_KIND_FIXTURES.criteria.spec as object), phase: "agreed" };
    expect(result("criteria", "review", { decisions: [{ criterionId: "narrow", decision: "waived" }] }, agreed).ok).toBe(false);
  });
});

describe("17 alternatives", () => {
  test("adoption names the exact reviewed commit", () => {
    expect(result("alternatives", "adopt", { alternativeId: "bounded-memory", commit: "zzz" }).ok).toBe(false);
    expect(result("alternatives", "adopt", { alternativeId: "bounded-memory", commit: "aaa111" }).ok).toBe(true);
  });
});

describe("18 workflow actions", () => {
  test("retry needs a failed node at the shown attempt and snapshot", () => {
    expect(result("workflow-actions", "retry-node", { nodeId: "lint", snapshotRevision: 4 }).ok).toBe(false);
    expect(result("workflow-actions", "retry-node", { nodeId: "validation", attemptId: "attempt-2", snapshotRevision: 4 }).ok).toBe(false);
    expect(result("workflow-actions", "retry-node", { nodeId: "validation", attemptId: "attempt-3", snapshotRevision: 3 }).ok).toBe(false);
    expect(result("workflow-actions", "retry-node", { nodeId: "validation", attemptId: "attempt-3", snapshotRevision: 4 }).ok).toBe(true);
  });
});

describe("20 demonstration", () => {
  test("routes never carry query strings and steps are trimmed by id", () => {
    const leaky = structuredClone(RICH_KIND_FIXTURES.demonstration.spec) as { steps: Array<Record<string, unknown>> };
    leaky.steps[0]!.route = "/items?token=secret";
    expect(validated(() => spec("demonstration", leaky)).ok).toBe(false);
    expect(result("demonstration", "send", { stepIds: ["step-1"], expectedOutcome: "x" }).ok).toBe(true);
    expect(result("demonstration", "send", { stepIds: ["step-9"], expectedOutcome: "x" }).ok).toBe(false);
  });
});
