import { describe, expect, test } from "bun:test";
import type { WorkflowGraphOutputContext } from "@orkestrator/protocol/graphs/output-slots";
import {
  graphProvenanceDroppedSchema,
  validateGraphProvenance,
} from "@orkestrator/protocol/graphs/provenance";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import type {
  WorkflowResultSlotInput,
  WorkflowResultValidationIssue,
} from "@orkestrator/protocol/workflow-results";
import { evaluationCorpus } from "./multi-review-evaluation-corpus.js";
import { referenceConsolidation } from "./multi-review-evaluation.js";
import { consolidationResultContext } from "./review-fanout-provenance.js";
import {
  REVIEW_CONSOLIDATION_PROVENANCE,
  REVIEW_CONSOLIDATION_WORDING,
  validateWorkflowResult,
} from "./workflow-result-contracts.js";

type ConsolidationContext = Extract<
  NonNullable<WorkflowResultSlotInput["context"]>,
  { type: "consolidated-review" }
>;
// Tests edit payloads into shapes the types forbid.
// oxlint-disable-next-line typescript/no-explicit-any
type Draft = any;

/**
 * The consolidation context check exactly as it was before the registry
 * (`workflow-result-contracts.ts` at the 004 merge), kept here as the oracle
 * the generic provenance validator must reproduce.
 */
function legacyConsolidationContext(
  value: Record<string, unknown>,
  context: ConsolidationContext,
): WorkflowResultValidationIssue[] {
  const record = (candidate: unknown): candidate is Record<string, unknown> =>
    candidate !== null && typeof candidate === "object" && !Array.isArray(candidate);
  const issue = (path: string, code: string, message: string) => ({
    path: path.slice(0, 256),
    code,
    message: message.slice(0, 512),
  });
  const issues: WorkflowResultValidationIssue[] = [];
  const inspect = (findings: unknown, kind: "issue" | "coverage-gap", path: string): void => {
    if (!Array.isArray(findings)) return;
    findings.forEach((finding, index) => {
      if (!record(finding)) return;
      if (Array.isArray(finding.reviewModels) && finding.reviewModels.length > 0) {
        issues.push(
          issue(
            `${path}[${index}].reviewModels`,
            "invalid_value",
            "Cite source IDs; the backend derives contributing review models.",
          ),
        );
      }
      if (!Array.isArray(finding.reviewSourceIds) || finding.reviewSourceIds.length === 0) {
        issues.push(
          issue(
            `${path}[${index}].reviewSourceIds`,
            "missing_field",
            "Every consolidated finding must cite at least one source finding ID.",
          ),
        );
        return;
      }
      finding.reviewSourceIds.forEach((sourceId, sourceIndex) => {
        if (typeof sourceId !== "string" || context.sources[sourceId] !== kind) {
          issues.push(
            issue(
              `${path}[${index}].reviewSourceIds[${sourceIndex}]`,
              "invalid_value",
              `The source does not identify a ${kind} in the supplied reviewer reports.`,
            ),
          );
        }
      });
    });
  };
  inspect(value.issues, "issue", "$.issues");
  inspect(value.testCoverageGaps, "coverage-gap", "$.testCoverageGaps");
  return issues.slice(0, 32);
}

function generic(value: Record<string, unknown>, context: ConsolidationContext) {
  return validateGraphProvenance(
    value,
    REVIEW_CONSOLIDATION_PROVENANCE,
    context.sources,
    REVIEW_CONSOLIDATION_WORDING,
  ).slice(0, 32);
}

/** Every way a consolidator's citations can go wrong, applied to one valid report. */
function variants(
  report: StructuredReviewReport,
  context: ConsolidationContext,
): Array<[string, Draft]> {
  const clone = (): Draft => structuredClone(report);
  const ids = Object.keys(context.sources);
  const gapId = ids.find((id) => context.sources[id] === "coverage-gap");
  const issueId = ids.find((id) => context.sources[id] === "issue");
  const each = (field: "issues" | "testCoverageGaps", change: (finding: Draft) => void) => {
    const value = clone();
    value[field].forEach(change);
    return value;
  };
  const cases: Array<[string, Draft]> = [
    ["reference", clone()],
    [
      "invented source",
      each("issues", (finding) => finding.reviewSourceIds.push("reviewer-9/issue-9")),
    ],
    ["empty citations", each("issues", (finding) => (finding.reviewSourceIds = []))],
    ["missing citations", each("testCoverageGaps", (finding) => delete finding.reviewSourceIds)],
    ["null citations", each("issues", (finding) => (finding.reviewSourceIds = null))],
    ["review models filled in", each("issues", (finding) => (finding.reviewModels = ["model"]))],
    [
      "review models with no citations",
      each("testCoverageGaps", (finding) => {
        finding.reviewModels = ["model"];
        finding.reviewSourceIds = [];
      }),
    ],
    ["empty review models", each("issues", (finding) => (finding.reviewModels = []))],
    ["non-string IDs", each("issues", (finding) => (finding.reviewSourceIds = [7, null, {}]))],
    [
      "prototype keys",
      each("issues", (finding) => (finding.reviewSourceIds = ["constructor", "__proto__"])),
    ],
    ["lists that are not arrays", { ...clone(), issues: "none", testCoverageGaps: { a: 1 } }],
    ["entries that are not objects", { ...clone(), issues: [null, 3, "x", []] }],
    [
      "over the issue cap",
      {
        ...clone(),
        issues: Array.from({ length: 40 }, () => ({
          reviewSourceIds: ["unknown"],
          reviewModels: ["m"],
        })),
      },
    ],
  ];
  if (gapId)
    cases.push([
      "an issue citing a coverage gap",
      each("issues", (finding) => finding.reviewSourceIds.push(gapId)),
    ]);
  if (issueId)
    cases.push([
      "a coverage gap citing an issue",
      each("testCoverageGaps", (finding) => (finding.reviewSourceIds = [issueId])),
    ]);
  return cases;
}

describe("review consolidation runs through the generic provenance validator", () => {
  const corpus = evaluationCorpus();

  test.each(corpus.map((entry) => [entry.id, entry] as const))(
    "%s: every variant gets the legacy diagnostics, message for message",
    (_id, entry) => {
      const context = consolidationResultContext(entry.reviewers);
      const reference = referenceConsolidation(entry);
      let compared = 0;
      for (const [label, value] of variants(reference, context)) {
        const expected = legacyConsolidationContext(value, context);
        expect({ label, issues: generic(value, context) }).toEqual({ label, issues: expected });
        compared += expected.length;
      }
      // The variants exercise the check, not just the clean path.
      expect(compared).toBeGreaterThan(0);
    },
  );

  test("the full consolidated-review path equals the report checks plus the legacy context check", () => {
    for (const entry of corpus) {
      const context = consolidationResultContext(entry.reviewers);
      for (const [label, value] of variants(referenceConsolidation(entry), context)) {
        const report = validateWorkflowResult("review-report", value);
        const expected =
          report.length > 0 && !report.some((issue) => issue.code === "placeholder_value")
            ? report
            : [...report, ...legacyConsolidationContext(value, context)].slice(0, 32);
        expect({
          label,
          issues: validateWorkflowResult("consolidated-review", value, undefined, context),
        }).toEqual({ label, issues: expected });
      }
    }
  });

  test("the existing fixtures: an invented source, and a context at its 4,096-source bound", () => {
    const sources = Object.fromEntries(
      Array.from({ length: 4_096 }, (_, index) => [`reviewer-${index}:0`, "issue" as const]),
    );
    const context: ConsolidationContext = { type: "consolidated-review", sources };
    const entry = corpus[0]!;
    const value: Draft = structuredClone(referenceConsolidation(entry));
    value.issues = [{ ...value.issues[0], reviewSourceIds: ["reviewer-9:4", "reviewer-4095:0"] }];
    expect(generic(value, context)).toEqual(legacyConsolidationContext(value, context));
    expect(generic(value, context)).toEqual([
      {
        path: "$.issues[0].reviewSourceIds[0]",
        code: "invalid_value",
        message: "The source does not identify a issue in the supplied reviewer reports.",
      },
    ]);
  });
});

describe("provenance on a non-review custom type", () => {
  const ids = { type: "array", items: { type: "string" }, "x-orkestrator-sources": true };
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["summary", "options", "dropped"],
    properties: {
      summary: { type: "string" },
      options: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "sources"],
          properties: { title: { type: "string" }, sources: ids },
        },
      },
      dropped: graphProvenanceDroppedSchema(),
    },
  };
  const context = (mode: "cite" | "accountForAll"): WorkflowGraphOutputContext => ({
    type: "graph-output",
    port: "shortlist",
    artifactType: "design-shortlist@1",
    storage: "value",
    budgets: { maxBytes: 65_536 },
    provenance: {
      mode,
      fields: [{ segments: ["options", "[]", "sources"] }],
      ...(mode === "accountForAll" ? { droppedField: "dropped" } : {}),
      sources: { "brief-1/option-1": "option@1", "brief-2/option-1": "option@1" },
    },
  });

  test("cite rejects an invented source and accepts real ones", () => {
    const invented = {
      summary: "Two options.",
      options: [{ title: "Cache", sources: ["brief-1/option-1", "brief-3/option-1"] }],
      dropped: [],
    };
    expect(validateWorkflowResult("graph-output", invented, schema, context("cite"))).toEqual([
      {
        path: "$.options[0].sources[1]",
        code: "invalid_value",
        message: "The source does not identify an item in the node's inputs.",
      },
    ]);
    invented.options[0]!.sources.pop();
    expect(validateWorkflowResult("graph-output", invented, schema, context("cite"))).toEqual([]);
  });

  test("accountForAll needs every source cited or dropped with a reason", () => {
    const value = {
      summary: "One option.",
      options: [{ title: "Cache", sources: ["brief-1/option-1"] }],
      dropped: [],
    };
    expect(validateWorkflowResult("graph-output", value, schema, context("accountForAll"))).toEqual(
      [
        {
          path: "$.dropped",
          code: "unaccounted_source",
          message: "Cite source brief-2/option-1, or list it in dropped with a reason.",
        },
      ],
    );
    const dropped = { ...value, dropped: [{ id: "brief-2/option-1", reason: "Too slow." }] };
    expect(
      validateWorkflowResult("graph-output", dropped, schema, context("accountForAll")),
    ).toEqual([]);
  });
});
