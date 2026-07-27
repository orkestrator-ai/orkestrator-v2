import {
  REVIEW_CHANGE_TYPES,
  REVIEW_ISSUE_CATEGORIES,
  REVIEW_OVERALL_RISKS,
  REVIEW_SEVERITIES,
  REVIEW_VERDICTS,
} from "./types";

export type ReviewJsonSchema = Readonly<Record<string, unknown>>;

const nullableLineSchema = {
  anyOf: [
    { type: "integer", minimum: 1 },
    { type: "null" },
  ],
} as const;

const commitSchema = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["sha", "subject"],
      properties: {
        sha: { type: "string" },
        subject: { type: "string" },
      },
    },
    { type: "null" },
  ],
} as const;

const scopedFileSchema = {
  type: "object",
  additionalProperties: false,
  required: ["file", "reason"],
  properties: {
    file: { type: "string" },
    reason: { type: "string" },
  },
} as const;

const commandResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["command", "result", "summary"],
  properties: {
    command: { type: "string" },
    result: { type: "string", enum: ["passed", "failed"] },
    summary: { type: "string" },
  },
} as const;

const skippedCommandSchema = {
  type: "object",
  additionalProperties: false,
  required: ["command", "reason"],
  properties: {
    command: { type: "string" },
    reason: { type: "string" },
  },
} as const;

const reviewIssueSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "severity",
    "confidence",
    "category",
    "title",
    "file",
    "line",
    "symbol",
    "description",
    "evidence",
    "suggestion",
    "verification",
    "alternativeFixes",
  ],
  properties: {
    severity: { type: "string", enum: REVIEW_SEVERITIES },
    confidence: { type: "integer", minimum: 0, maximum: 100 },
    category: { type: "string", enum: REVIEW_ISSUE_CATEGORIES },
    title: { type: "string" },
    file: { type: "string" },
    line: nullableLineSchema,
    symbol: { type: "string" },
    description: { type: "string" },
    evidence: { type: "string" },
    suggestion: { type: "string" },
    verification: { type: "string" },
    alternativeFixes: {
      anyOf: [
        {
          type: "array",
          items: { type: "string" },
        },
        { type: "null" },
      ],
    },
  },
} as const;

const coverageGapSchema = {
  type: "object",
  additionalProperties: false,
  required: ["file", "untestedBehavior"],
  properties: {
    file: { type: "string" },
    untestedBehavior: { type: "string" },
  },
} as const;

const pooledReviewIssueSchema = {
  ...reviewIssueSchema,
  required: [...reviewIssueSchema.required, "poolId"],
  properties: {
    poolId: { type: "string" },
    ...reviewIssueSchema.properties,
  },
} as const;

const pooledCoverageGapSchema = {
  ...coverageGapSchema,
  required: [...coverageGapSchema.required, "poolId"],
  properties: {
    poolId: { type: "string" },
    ...coverageGapSchema.properties,
  },
} as const;

/**
 * Fixed provider-facing JSON Schema for complete native review results.
 *
 * This deliberately uses only the portable subset shared by the native
 * providers: objects, arrays, primitive types, enums, bounds, and `anyOf`.
 */
export const STRUCTURED_REVIEW_REPORT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "reviewScope",
    "whatChanged",
    "riskProfile",
    "testResults",
    "strengths",
    "issues",
    "testCoverageGaps",
    "verdict",
    "summaryOfChange",
    "reviewSummary",
  ],
  properties: {
    reviewScope: {
      type: "object",
      additionalProperties: false,
      required: [
        "targetBranch",
        "baseRef",
        "commit",
        "filesReviewed",
        "filesSkipped",
        "filesLeftUncommitted",
        "commandsRun",
        "commandsNotRun",
        "limitations",
      ],
      properties: {
        targetBranch: { type: "string" },
        baseRef: { type: "string" },
        commit: commitSchema,
        filesReviewed: {
          type: "array",
          items: { type: "string" },
        },
        filesSkipped: {
          type: "array",
          items: scopedFileSchema,
        },
        filesLeftUncommitted: {
          type: "array",
          items: scopedFileSchema,
        },
        commandsRun: {
          type: "array",
          items: commandResultSchema,
        },
        commandsNotRun: {
          type: "array",
          items: skippedCommandSchema,
        },
        limitations: {
          type: "array",
          items: { type: "string" },
        },
      },
    },
    whatChanged: {
      type: "object",
      additionalProperties: false,
      required: ["overview", "before", "after", "keyCodeChanges", "userImpact"],
      properties: {
        overview: { type: "string" },
        before: { type: "string" },
        after: { type: "string" },
        keyCodeChanges: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["file", "line", "description"],
            properties: {
              file: { type: "string" },
              line: nullableLineSchema,
              description: { type: "string" },
            },
          },
        },
        userImpact: { type: "string" },
      },
    },
    riskProfile: {
      type: "object",
      additionalProperties: false,
      required: ["changeTypes", "riskAreas", "overallRisk", "reasoning"],
      properties: {
        changeTypes: {
          type: "array",
          items: { type: "string", enum: REVIEW_CHANGE_TYPES },
        },
        riskAreas: {
          type: "array",
          items: { type: "string" },
        },
        overallRisk: { type: "string", enum: REVIEW_OVERALL_RISKS },
        reasoning: { type: "string" },
      },
    },
    testResults: {
      type: "object",
      additionalProperties: false,
      required: ["total", "passed", "failed", "notRun", "failures"],
      properties: {
        total: {
          type: "integer",
          minimum: 0,
          description: "All discovered tests. Must equal passed plus failed plus notRun.",
        },
        passed: { type: "integer", minimum: 0 },
        failed: { type: "integer", minimum: 0 },
        notRun: {
          type: "integer",
          minimum: 0,
          description: "Discovered tests not executed, including skipped, todo, pending, or disabled cases.",
        },
        failures: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["testName", "file", "errorMessage"],
            properties: {
              testName: { type: "string" },
              file: { type: "string" },
              errorMessage: { type: "string" },
            },
          },
        },
      },
    },
    strengths: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description", "file", "line"],
        properties: {
          description: { type: "string" },
          file: { type: "string" },
          line: nullableLineSchema,
        },
      },
    },
    issues: {
      type: "array",
      items: reviewIssueSchema,
    },
    testCoverageGaps: {
      type: "array",
      items: coverageGapSchema,
    },
    verdict: {
      type: "object",
      additionalProperties: false,
      required: ["ready", "reasoning"],
      properties: {
        ready: { type: "string", enum: REVIEW_VERDICTS },
        reasoning: { type: "string" },
      },
    },
    summaryOfChange: { type: "string" },
    reviewSummary: { type: "string" },
  },
} as const satisfies ReviewJsonSchema;

export const REVIEW_FINDING_POOL_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["issues", "coverageGaps"],
  properties: {
    issues: {
      type: "array",
      items: pooledReviewIssueSchema,
    },
    coverageGaps: {
      type: "array",
      items: pooledCoverageGapSchema,
    },
  },
} as const satisfies ReviewJsonSchema;

export const REVIEW_RECONCILIATION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "newIssues",
    "issueUpdates",
    "newCoverageGaps",
    "coverageGapUpdates",
  ],
  properties: {
    newIssues: {
      type: "array",
      items: reviewIssueSchema,
    },
    issueUpdates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["poolId", "finding"],
        properties: {
          poolId: { type: "string" },
          finding: reviewIssueSchema,
        },
      },
    },
    newCoverageGaps: {
      type: "array",
      items: coverageGapSchema,
    },
    coverageGapUpdates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["poolId", "finding"],
        properties: {
          poolId: { type: "string" },
          finding: coverageGapSchema,
        },
      },
    },
  },
} as const satisfies ReviewJsonSchema;

// Concise aliases for callers that already establish structured-review context.
export const REVIEW_REPORT_SCHEMA = STRUCTURED_REVIEW_REPORT_JSON_SCHEMA;
export const REVIEW_FINDING_POOL_SCHEMA = REVIEW_FINDING_POOL_JSON_SCHEMA;
export const REVIEW_RECONCILIATION_SCHEMA = REVIEW_RECONCILIATION_JSON_SCHEMA;
