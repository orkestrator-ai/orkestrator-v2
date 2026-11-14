/**
 * A complete consolidated report, as a shape template the consolidation
 * prompt shows (`createMultiReviewConsolidationPrompt`).
 *
 * Consolidation agents kept sending a 20 KB report that missed a required
 * top-level object (`testResults`, `whatChanged`, `riskProfile`), added a key
 * to `reviewScope`, or put `null` where a string belongs (`symbol`, a
 * strength's `file`), and each miss cost another full resend. The schema
 * alone did not prevent it; one example of every key, enum spelling and null
 * in place does. Every string here describes what goes there, so a model that
 * copied it verbatim would hand in a report of descriptions, not a plausible
 * fake. `review-consolidation-example.test.ts` checks the template against
 * the consolidated-review contract (schema, domain checks and citations), so
 * a schema change that this template does not follow fails there first.
 */
import { STRUCTURED_REVIEW_REPORT_JSON_SCHEMA } from "@orkestrator/protocol/structured-review";

/** The source ID strings the template cites, for the test's trusted context. */
export const CONSOLIDATED_REVIEW_EXAMPLE_SOURCE_IDS = Object.freeze({
  issue: "<reviewSourceIds value of a source issue>",
  coverageGap: "<reviewSourceIds value of a source coverage gap>",
});

/**
 * The wire shape, as a submission carries it (nullable fields as `null`), not
 * the parsed `StructuredReviewReport`, which reads those as absent.
 */
export const CONSOLIDATED_REVIEW_EXAMPLE = {
  reviewScope: {
    targetBranch: "<target branch>",
    baseRef: "<base SHA>...<head SHA>",
    commit: { sha: "<head SHA>", subject: "<head commit subject>" },
    filesReviewed: ["<path/of/a/reviewed/file.ts>"],
    filesSkipped: [{ file: "<path/of/a/skipped/file>", reason: "<why it was skipped>" }],
    filesLeftUncommitted: [],
    commandsRun: [
      {
        command: "<command a reviewer ran>",
        result: "passed",
        summary: "<what it showed>",
      },
    ],
    commandsNotRun: [{ command: "<command not run>", reason: "<why not>" }],
    limitations: ["<what the reviews could not cover>"],
    outcome: "reviewed",
    blockedReason: null,
  },
  whatChanged: {
    overview: "<two to four sentences: what the change does and why>",
    before: "<the relevant behaviour before the change>",
    after: "<the relevant behaviour after the change>",
    keyCodeChanges: [
      {
        file: "<path/of/a/changed/file.ts>",
        line: 42,
        description: "<how this code change produces the behaviour>",
      },
    ],
    userImpact: "<who or what is affected>",
  },
  riskProfile: {
    changeTypes: ["bugfix"],
    riskAreas: ["<an affected domain or hazard>"],
    overallRisk: "medium",
    reasoning: "<why the change carries that risk>",
  },
  testResults: {
    total: 3,
    passed: 2,
    failed: 1,
    notRun: 0,
    failures: [
      {
        testName: "<failing test name>",
        file: "<path/of/the/test.ts>",
        errorMessage: "<its failure message>",
      },
    ],
  },
  strengths: [
    {
      description: "<a strength of the change>",
      file: "<path/of/the/file.ts>",
      line: null,
    },
  ],
  issues: [
    {
      severity: "P1",
      confidence: 90,
      category: "correctness",
      title: "<one-line title>",
      file: "<path/of/the/file.ts>",
      line: 17,
      symbol: "<function or symbol name, or an empty string>",
      description: "<what is wrong>",
      evidence: "<the evidence the reviewers gave>",
      suggestion: "<the recommended fix>",
      verification: "<how to confirm the fix>",
      alternativeFixes: ["<another fix>"],
      reviewModels: null,
      reviewSourceIds: [CONSOLIDATED_REVIEW_EXAMPLE_SOURCE_IDS.issue],
    },
  ],
  testCoverageGaps: [
    {
      file: "<path/of/the/untested/file.ts>",
      untestedBehavior: "<the behaviour no test covers>",
      reviewModels: null,
      reviewSourceIds: [CONSOLIDATED_REVIEW_EXAMPLE_SOURCE_IDS.coverageGap],
    },
  ],
  verdict: { ready: "with-fixes", reasoning: "<why, citing the findings>" },
  summaryOfChange: "<one paragraph on the change>",
  reviewSummary: "<one paragraph on the review's conclusions>",
};

/**
 * The prompt section carrying the template. It names the common misses
 * explicitly, because those are the ones a second call was spent on.
 */
export function consolidatedReviewExampleSection(): string {
  return `## Consolidated report shape

The JSON below has the exact shape the consolidated report must have: every required key at every level, the enum spellings, and \`null\` where a nullable field has no value. It is a shape template, not content. Replace every \`<...>\` string with content from the reviewer reports, use as many array entries as the reports need (including none), and copy real \`reviewSourceIds\` values from the source findings. Its authoritative JSON Schema is the result's own schema (the submission tool's input schema when a result tool is assigned).

\`\`\`json
${JSON.stringify(CONSOLIDATED_REVIEW_EXAMPLE, null, 2)}
\`\`\`

Before sending it, check the misses that most often cost a resend: all ${STRUCTURED_REVIEW_REPORT_JSON_SCHEMA.required.length} top-level keys are present (\`testResults\`, \`whatChanged\` and \`riskProfile\` included, even when there is little to say); \`reviewScope\` has exactly the keys shown; \`file\` and \`symbol\` are always strings, never \`null\`; \`line\` is a positive integer or \`null\`; and \`testResults.total\` equals \`passed + failed + notRun\`, with one \`failures\` entry per failed test.`;
}
