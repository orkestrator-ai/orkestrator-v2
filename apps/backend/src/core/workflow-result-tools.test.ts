import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFeaturePlannerState } from "@orkestrator/protocol/feature-planning";
import { safeParseStructuredReviewReport } from "@orkestrator/protocol/structured-review";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import { WORKFLOW_RESULT_KINDS } from "@orkestrator/protocol/workflow-results";
import {
  validateWorkflowJsonSchema,
  validateWorkflowResult,
  workflowResultJsonSchema,
} from "./workflow-result-contracts.js";
import { WorkflowResultService } from "./workflow-result-service.js";

const report: StructuredReviewReport = {
  reviewScope: {
    targetBranch: "main",
    baseRef: "origin/main...HEAD",
    commit: null,
    filesReviewed: [],
    filesSkipped: [],
    filesLeftUncommitted: [],
    commandsRun: [],
    commandsNotRun: [],
    limitations: ["Could not run the integration suite."],
  },
  whatChanged: {
    overview: "No change.",
    before: "Before.",
    after: "After.",
    keyCodeChanges: [],
    userImpact: "None.",
  },
  riskProfile: { changeTypes: [], riskAreas: [], overallRisk: "low", reasoning: "Low." },
  testResults: { total: 0, passed: 0, failed: 0, notRun: 0, failures: [] },
  strengths: [],
  issues: [],
  testCoverageGaps: [],
  verdict: { ready: "no", reasoning: "The suite did not run." },
  summaryOfChange: "No change.",
  reviewSummary: "No high-confidence issues were found.",
};

describe("workflow result contract validation", () => {
  test("every kind exposes a model-facing schema", () => {
    for (const kind of WORKFLOW_RESULT_KINDS) {
      const schema = workflowResultJsonSchema(kind);
      expect(schema).toBeTruthy();
      expect(Object.keys(schema as Record<string, unknown>).length).toBeGreaterThan(0);
    }
  });

  test("a valid result for every kind is accepted with no diagnostics", () => {
    const valid: Record<string, unknown> = {
      "feature-plan-state": { phase: "collecting", title: "Feature", summary: "Summary." },
      "story-refinement": {
        storyId: "story-1",
        title: "Story",
        description: "Description.",
        acceptanceCriteria: ["Criterion"],
      },
      "review-report": report,
      "consolidated-review": report,
      "verification-result": { complete: false, rationale: "Validation did not pass." },
    };
    for (const [kind, value] of Object.entries(valid)) {
      expect(validateWorkflowResult(kind as (typeof WORKFLOW_RESULT_KINDS)[number], value)).toEqual(
        [],
      );
    }
  });

  test("an explicit negative outcome is a valid result, not a rejection", () => {
    expect(
      validateWorkflowResult("verification-result", {
        complete: false,
        rationale: "Two checks failed.",
      }),
    ).toEqual([]);
    const negative = validateWorkflowResult("review-report", report);
    expect(negative).toEqual([]);
  });

  test("wrong types, unknown properties, and enum confusion are reported by path", () => {
    const issues = validateWorkflowResult("feature-plan-state", {
      phase: "stories ",
      title: 12,
      summary: "",
      unexpected: true,
    });
    const paths = issues.map((issue) => issue.path);
    expect(paths).toContain("$.phase");
    expect(paths).toContain("$.unexpected");
    expect(issues.some((issue) => issue.code === "invalid_enum")).toBe(true);
    expect(issues.some((issue) => issue.code === "unknown_field")).toBe(true);
  });

  test("a missing required field is reported rather than defaulted", () => {
    const issues = validateWorkflowResult("story-refinement", {
      storyId: "story-1",
      title: "Story",
    });
    expect(issues.some((issue) => issue.path === "$.description")).toBe(true);
    expect(issues.every((issue) => issue.code === "missing_field")).toBe(true);
  });

  test("diagnostics stay bounded in count and per-issue length", () => {
    const wide: Record<string, unknown> = {
      phase: "collecting",
      title: "T",
      summary: "S",
    };
    for (let index = 0; index < 200; index += 1) wide[`extra${index}`] = index;
    const issues = validateWorkflowResult("feature-plan-state", wide);
    expect(issues.length).toBeLessThanOrEqual(32);
    for (const issue of issues) {
      expect(issue.path.length).toBeLessThanOrEqual(256);
      expect(issue.message.length).toBeLessThanOrEqual(512);
    }
  });

  test("excessive nesting is refused instead of walked", () => {
    let deep: unknown = "leaf";
    for (let index = 0; index < 64; index += 1) deep = { nested: deep };
    const schema = {
      type: "object",
      properties: { nested: {} },
    } as const;
    let deepSchema: Record<string, unknown> = { type: "object", properties: {} };
    let cursor = deepSchema;
    for (let index = 0; index < 64; index += 1) {
      const next: Record<string, unknown> = { type: "object", properties: {} };
      (cursor.properties as Record<string, unknown>).nested = next;
      cursor = next;
    }
    void schema;
    const issues = validateWorkflowJsonSchema(deepSchema, deep);
    expect(issues.some((issue) => issue.code === "too_deep")).toBe(true);
  });

  test("a legacy tagged payload and a tool payload accept the same domain result", () => {
    const value = {
      phase: "stories",
      title: "Feature",
      summary: "Summary.",
      stories: [
        { id: "s1", title: "Story", description: "Description.", acceptanceCriteria: ["One"] },
      ],
    };
    const tagged = `prose\n<feature_planner_state>\n${JSON.stringify(value)}\n</feature_planner_state>`;
    expect(validateWorkflowResult("feature-plan-state", value)).toEqual([]);
    expect(parseFeaturePlannerState(tagged)).toEqual(
      parseFeaturePlannerState(
        `<feature_planner_state>${JSON.stringify(value)}</feature_planner_state>`,
      ),
    );
  });

  test("accepting a report does not rewrite its limitations, verdict, or confidence", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ork-workflow-result-tools-"));
    try {
      const service = new WorkflowResultService(dataDir);
      const resultKey = crypto.randomUUID();
      const scope = { environmentId: "env-1", projectId: "project-1" };
      await service.prepare({ resultKey, kind: "review-report", ...scope, provider: "codex" });
      const submission = await service.submit(scope, resultKey, report);
      expect(submission.ok).toBe(true);
      const stored = await service.structured<StructuredReviewReport>(resultKey);
      if (!stored?.ok) throw new Error("Expected an accepted report");
      // Acceptance stores the model's judgment verbatim. Nothing here may
      // normalize a limitation away or soften a negative verdict.
      expect(stored.value).toEqual(report);
      expect(stored.value.reviewScope.limitations).toEqual([
        "Could not run the integration suite.",
      ]);
      expect(stored.value.verdict).toEqual({ ready: "no", reasoning: "The suite did not run." });
      expect(safeParseStructuredReviewReport(stored.value).success).toBe(true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("workflow result context fencing", () => {
  let dataDir: string;
  let service: WorkflowResultService;
  const scope = { environmentId: "env-1", projectId: "project-1" };

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ork-workflow-result-tools-"));
    service = new WorkflowResultService(dataDir);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a consolidated finding citing an unknown source is rejected", async () => {
    const resultKey = crypto.randomUUID();
    await service.prepare({
      resultKey,
      kind: "consolidated-review",
      ...scope,
      provider: "claude",
      context: { type: "consolidated-review", sources: { "reviewer-1:0": "issue" } },
    });
    const invented = {
      ...report,
      issues: [
        {
          severity: "medium",
          title: "Invented",
          description: "Cites a source that no reviewer produced.",
          location: "src/a.ts",
          recommendation: "None.",
          confidence: "medium",
          reviewSourceIds: ["reviewer-9:4"],
        },
      ],
    };
    const rejected = await service.submit(scope, resultKey, invented);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe("invalid_result");
      expect(rejected.error.nextAction).toBe("correct");
    }
  });

  test("a submission with no accepted slot is denied rather than fabricated", async () => {
    const denied = await service.submit(scope, crypto.randomUUID(), { phase: "collecting" });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("capability_denied");
  });

  test("status for an unknown key reports absence without recommending redispatch", async () => {
    expect(await service.status(scope, crypto.randomUUID())).toBeNull();
  });
});
