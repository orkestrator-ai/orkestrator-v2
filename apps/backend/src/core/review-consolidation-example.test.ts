import { describe, expect, test } from "bun:test";
import {
  STRUCTURED_REVIEW_REPORT_JSON_SCHEMA,
  safeParseStructuredReviewReport,
} from "@orkestrator/protocol/structured-review";
import { validateWorkflowJsonSchema } from "@orkestrator/protocol/workflow-json-schema";
import {
  CONSOLIDATED_REVIEW_EXAMPLE,
  CONSOLIDATED_REVIEW_EXAMPLE_SOURCE_IDS,
  consolidatedReviewExampleSection,
} from "./review-consolidation-example.js";
import { createMultiReviewConsolidationPrompt } from "./multi-review-prompts.js";
import { decodeResult, jsonSchemaField, strictObject } from "./tool-schema.js";
import { validateWorkflowResult } from "./workflow-result-contracts.js";
import { workflowResultProviderSchema } from "./workflow-result-registry.js";

const context = {
  type: "consolidated-review" as const,
  sources: {
    [CONSOLIDATED_REVIEW_EXAMPLE_SOURCE_IDS.issue]: "issue" as const,
    [CONSOLIDATED_REVIEW_EXAMPLE_SOURCE_IDS.coverageGap]: "coverage-gap" as const,
  },
};

describe("consolidated review example", () => {
  test("passes the whole consolidated-review contract a submission is checked against", () => {
    expect(
      validateWorkflowResult(
        "consolidated-review",
        CONSOLIDATED_REVIEW_EXAMPLE,
        undefined,
        context,
      ),
    ).toEqual([]);
    expect(safeParseStructuredReviewReport(CONSOLIDATED_REVIEW_EXAMPLE).success).toBe(true);
    expect(
      validateWorkflowJsonSchema(STRUCTURED_REVIEW_REPORT_JSON_SCHEMA, CONSOLIDATED_REVIEW_EXAMPLE),
    ).toEqual([]);
  });

  test("passes the submission tool's own input schema", () => {
    const input = strictObject({
      result: jsonSchemaField(workflowResultProviderSchema("consolidated-review", {})),
    });
    expect(decodeResult(input, { result: CONSOLIDATED_REVIEW_EXAMPLE }).success).toBe(true);
  });

  test("carries every required key of the report and of each nested object", () => {
    const example = CONSOLIDATED_REVIEW_EXAMPLE as unknown as Record<string, unknown>;
    expect(Object.keys(example).sort()).toEqual(
      [...STRUCTURED_REVIEW_REPORT_JSON_SCHEMA.required].sort(),
    );
    for (const [name, property] of Object.entries(
      STRUCTURED_REVIEW_REPORT_JSON_SCHEMA.properties,
    )) {
      const nested = property as { required?: readonly string[] };
      if (!nested.required) continue;
      expect(Object.keys(example[name] as object).sort()).toEqual([...nested.required].sort());
    }
    // Every array of findings has an entry, so each entry's shape is shown.
    for (const list of [
      CONSOLIDATED_REVIEW_EXAMPLE.issues,
      CONSOLIDATED_REVIEW_EXAMPLE.testCoverageGaps,
      CONSOLIDATED_REVIEW_EXAMPLE.strengths,
      CONSOLIDATED_REVIEW_EXAMPLE.testResults.failures,
    ]) {
      expect(list.length).toBeGreaterThan(0);
    }
  });

  test("is a template of descriptions, not content a model could pass off as its own", () => {
    const strings: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === "string") strings.push(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(CONSOLIDATED_REVIEW_EXAMPLE);
    const enumValues = new Set(["passed", "reviewed", "bugfix", "medium", "P1", "correctness"]);
    const free = strings.filter((value) => !enumValues.has(value) && value !== "with-fixes");
    expect(free.length).toBeGreaterThan(20);
    for (const value of free) expect(value).toMatch(/<[^>]+>/);
  });

  test("the consolidation prompt shows the example and names the common misses", () => {
    const section = consolidatedReviewExampleSection();
    expect(section).toContain(JSON.stringify(CONSOLIDATED_REVIEW_EXAMPLE, null, 2));
    expect(section).toContain("all 10 top-level keys are present");
    expect(section).toContain("`file` and `symbol` are always strings, never `null`");
    const prompt = createMultiReviewConsolidationPrompt({ targetBranch: "main", reports: [] });
    expect(prompt).toContain(section);
    expect(prompt.endsWith(section)).toBe(true);
  });
});
