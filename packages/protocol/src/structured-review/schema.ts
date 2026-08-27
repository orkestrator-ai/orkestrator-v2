import {
  REVIEW_CHANGE_TYPES,
  REVIEW_ISSUE_CATEGORIES,
  REVIEW_OVERALL_RISKS,
  REVIEW_SEVERITIES,
  REVIEW_VERDICTS,
} from "./types.js";

export type ReviewJsonSchema = Readonly<Record<string, unknown>>;

const nullableLineSchema = {
  anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }],
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
    "reviewModels",
    "reviewSourceIds",
  ],
  properties: {
    reviewModels: {
      anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }],
      description:
        "Backend-derived models whose reports substantiate this finding. Providers must return null.",
    },
    reviewSourceIds: {
      anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }],
      description:
        "Backend-issued source finding IDs. Copy every supporting ID during multi-model consolidation; null otherwise.",
    },
    severity: {
      type: "string",
      enum: REVIEW_SEVERITIES,
      description:
        "P0 breaks, crashes, loses data, or is a security hole. P1 is a real bug that will bite in practice. P2 is quality or polish.",
    },
    confidence: {
      type: "integer",
      minimum: 0,
      maximum: 100,
      description: "How certain the issue is real, 0-100. Report only issues at 75 or above.",
    },
    category: { type: "string", enum: REVIEW_ISSUE_CATEGORIES },
    title: { type: "string", description: "Short title naming the defect." },
    file: { type: "string", description: "Repository-relative path of the file the issue is in." },
    line: nullableLineSchema,
    symbol: {
      type: "string",
      description:
        "Enclosing class, method, or function name. Empty string when the issue is module-level.",
    },
    description: {
      type: "string",
      description: "One to three sentences stating what is wrong and why it matters.",
    },
    evidence: {
      type: "string",
      description:
        "The specific code behaviour, diff excerpt, or command output that demonstrates the issue. Never invent evidence.",
    },
    suggestion: { type: "string", description: "A concrete fix." },
    verification: {
      type: "string",
      description: "How to verify the fix, such as the command or test to run.",
    },
    alternativeFixes: {
      anyOf: [
        {
          type: "array",
          items: { type: "string" },
        },
        { type: "null" },
      ],
      description:
        "Alternative fixes, listed only when they carry meaningful trade-offs. Null otherwise.",
    },
  },
} as const;

const coverageGapSchema = {
  type: "object",
  additionalProperties: false,
  required: ["file", "untestedBehavior", "reviewModels", "reviewSourceIds"],
  properties: {
    reviewModels: {
      anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }],
      description:
        "Backend-derived models whose reports substantiate this gap. Providers must return null.",
    },
    reviewSourceIds: {
      anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }],
      description:
        "Backend-issued source coverage-gap IDs. Copy every supporting ID during multi-model consolidation; null otherwise.",
    },
    file: {
      type: "string",
      description: "Repository-relative path of the file whose behaviour lacks coverage.",
    },
    untestedBehavior: {
      type: "string",
      description:
        "The changed or affected behaviour that lacks meaningful coverage. Do not report unrelated pre-existing gaps.",
    },
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
      description:
        "What the review actually covered and ran. Never claim a command ran when it did not; record it under commandsNotRun with a reason instead.",
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
        baseRef: {
          type: "string",
          description: "The reviewed range, with the immutable base and head SHAs that were used.",
        },
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
      description:
        "Plain-language explanation of the change itself, separate from its quality. Never substitute the commit SHA, test results, risk assessment, verdict, or review findings for this explanation.",
      properties: {
        overview: {
          type: "string",
          description:
            "Two to four sentences answering what this change does and why, in user or product terms where applicable.",
        },
        before: {
          type: "string",
          description: "The relevant behaviour or structure before this change.",
        },
        after: {
          type: "string",
          description: "The relevant behaviour or structure after this change.",
        },
        keyCodeChanges: {
          type: "array",
          description:
            "One to five entries connecting the behaviour to specific implementation changes.",
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
        userImpact: {
          type: "string",
          description:
            "Who or what is affected. When there is no user-visible runtime effect, say so and describe the internal, test, documentation, or build effect instead.",
        },
      },
    },
    riskProfile: {
      type: "object",
      additionalProperties: false,
      description: "How risky the change is and why, judged from the reviewed diff.",
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
      description: "Counts the runner actually reported. Do not infer counts it did not provide.",
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
          description:
            "Discovered tests not executed, including skipped, todo, pending, or disabled cases.",
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
      description: "Specific things the change does well, each anchored to a file and line.",
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
      description:
        "Findings at confidence 75 or above, most severe first. Empty when nothing meets the threshold.",
      items: reviewIssueSchema,
    },
    testCoverageGaps: {
      type: "array",
      description:
        "Coverage gaps introduced by the change or needed to validate affected behaviour.",
      items: coverageGapSchema,
    },
    verdict: {
      type: "object",
      additionalProperties: false,
      required: ["ready", "reasoning"],
      properties: {
        ready: {
          type: "string",
          enum: REVIEW_VERDICTS,
          description:
            '"yes" to ship as is, "with-fixes" when the listed issues should be addressed first, "no" when it is not ready — including when validation could not be run.',
        },
        reasoning: { type: "string", description: "One to two sentences supporting the verdict." },
      },
    },
    summaryOfChange: {
      type: "string",
      description:
        "One or two paragraphs on what the change does and why, the before and after behaviour, the key implementation path, and the user or system impact. Describe only behaviour evidenced by the reviewed diff.",
    },
    reviewSummary: {
      type: "string",
      description:
        "One paragraph on the review itself. Do not claim the code is correct, fully secure, production-ready, or adequately tested unless the reviewed evidence supports it; no high-confidence issues found, tests passed, coverage looks adequate, and ready to ship are related but distinct claims.",
    },
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
  required: ["newIssues", "issueUpdates", "newCoverageGaps", "coverageGapUpdates"],
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
