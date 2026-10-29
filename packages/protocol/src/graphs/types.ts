/**
 * The graph type library (plan P1.2, report §5.3, D8): every edge carries an
 * artifact of a named, versioned type.
 *
 * Built-in types reuse today's schemas and domain validators, so a graph
 * artifact passes exactly when the equivalent workflow result would. Custom
 * types are template-declared {@link ArtifactTypeDef}s inside the portable
 * schema subset. {@link GraphTypeLibrary} resolves `name@major` and
 * `list<…>` references over both, and {@link validateGraphArtifactValue} is
 * the one value check (budgets, schema, domain validator) shared by the
 * backend, mock runs and the designer.
 *
 * Built-in schemas live with the code that validates them today; this module
 * maps them. Changing one changes the workflow result contract too, under the
 * version-compatibility rules (report §5.12).
 */
import {
  VERIFICATION_VERDICT_SCHEMA,
  type TaskSnapshot,
  taskSnapshotCriteria,
} from "../build-pipeline.js";
import type { GitHubPullRequestChecksState } from "../github-pull-requests.js";
import { reviewPackageArtifactPath } from "../review-artifacts.js";
import { REVIEW_FIX_RESULT_JSON_SCHEMA, REVIEW_PR_RESULT_JSON_SCHEMA } from "../review-results.js";
import { REVIEW_VALIDATION_PLAN_SCHEMA } from "../review-workflow.js";
import {
  STRUCTURED_REVIEW_MAX_FILES_REVIEWED,
  STRUCTURED_REVIEW_MAX_SOURCE_IDS,
  STRUCTURED_REVIEW_MAX_TEXT_BYTES,
  STRUCTURED_REVIEW_REPORT_JSON_SCHEMA,
} from "../structured-review.js";
import { TICKET_KINDS, TICKET_SECTION_LIMITS, type TicketKind } from "../ticket-sections.js";
import type { WorkflowResultKind, WorkflowResultValidationIssue } from "../workflow-results.js";
import type { ArtifactTypeBudgets, ArtifactTypeDef, GraphJsonSchema } from "./artifact-type-def.js";
import { GRAPH_TEMPLATE_BOUNDS, graphUtf8Bytes, parseGraphTypeRef } from "./grammar.js";
import { GRAPH_RETRY_CAUSES } from "./template-model.js";
import {
  type GraphSchemaSourcesField,
  validateGraphSchemaSubset,
  validateGraphSchemaValue,
} from "./schema-subset.js";
import {
  type GraphBuiltInValidatorId,
  type GraphTypeValidationContext,
  graphBuiltInValidator,
} from "./type-validators.js";

export {
  GRAPH_BUILT_IN_VALIDATOR_IDS,
  type GraphBuiltInValidator,
  type GraphBuiltInValidatorId,
  type GraphTypeValidationContext,
  graphBuiltInValidator,
  graphBuiltInValidators,
  isGraphRelativePath,
} from "./type-validators.js";

const KIB = 1024;
const MIB = 1024 * KIB;
const VALUE_CAP = GRAPH_TEMPLATE_BOUNDS.maxValueArtifactBytes;
/** The persisted review package cap (`MAX_PERSISTED_REVIEW_PACKAGE_BYTES` in the backend). */
const REVIEW_PACKAGE_MAX_BYTES = 16 * MIB;

// -------------------------------------------------------------------- shapes

/**
 * Port colours in the designer (report §5.10): incompatible families visibly
 * refuse to connect. `list` is any `list<…>`; `unknown` an unresolved ref.
 */
export const GRAPH_TYPE_FAMILIES = [
  "text",
  "ticket",
  "report",
  "workspace",
  "decision",
  "package",
  "error",
  "list",
  "unknown",
] as const;
export type GraphTypeFamily = (typeof GRAPH_TYPE_FAMILIES)[number];

export const GRAPH_BUILT_IN_TYPE_NAMES = [
  "text",
  "markdown",
  "ticket",
  "workspace",
  "validation-plan",
  "validation-results",
  "review-package",
  "review-report",
  "finding",
  "verification-verdict",
  "fix-result",
  "pr-result",
  "pr-description",
  "check-summary",
  "decision",
  "file-list",
  "error",
] as const;
export type GraphBuiltInTypeName = (typeof GRAPH_BUILT_IN_TYPE_NAMES)[number];

/** Existing formatters a built-in type's markdown render may use instead of its template. */
export const GRAPH_TYPE_FORMATTERS = ["structured-review-report"] as const;
export type GraphTypeFormatter = (typeof GRAPH_TYPE_FORMATTERS)[number];

/** A type the library resolved: built-in or custom, ready for the compiler. */
export interface GraphTypeDefinition extends ArtifactTypeDef {
  /** `name@version`. */
  ref: string;
  builtIn: boolean;
  family: GraphTypeFamily;
  /** Built-in types only: extra domain checks (`type-validators.ts`). */
  validator?: GraphBuiltInValidatorId;
  /** For types with `items`: the named type of one element, such as `finding@1`. */
  itemType?: string;
  /** Provenance fields: built-in ones, or `x-orkestrator-sources` in a custom schema. */
  sources: GraphSchemaSourcesField[];
  /** The workflow result kind whose backend checks also apply (item 103). */
  resultKind?: WorkflowResultKind;
  /** An existing formatter for `markdown` renders (item 105). */
  formatter?: GraphTypeFormatter;
}

export interface GraphBuiltInTypeDefinition extends GraphTypeDefinition {
  name: GraphBuiltInTypeName;
  builtIn: true;
  label: string;
  description: string;
  example: unknown;
}

/**
 * The type of a value on a port or an edge. `named` is a library type;
 * `shape` is an anonymous projection an edge transform produced (`pick`, or
 * `flatten` into elements without a named item type); `list` nests either.
 */
export type GraphValueType =
  | { kind: "named"; definition: GraphTypeDefinition }
  | { kind: "shape"; schema: GraphJsonSchema; budgets: ArtifactTypeBudgets; origin: string }
  | { kind: "list"; element: GraphValueType };

export function graphNamedType(definition: GraphTypeDefinition): GraphValueType {
  return { kind: "named", definition };
}

export function graphListType(element: GraphValueType): GraphValueType {
  return { kind: "list", element };
}

/** `review-report@1`, `list<finding@1>`, or a shape's origin. */
export function graphValueTypeLabel(type: GraphValueType): string {
  switch (type.kind) {
    case "named":
      return type.definition.ref;
    case "shape":
      return type.origin;
    case "list":
      return `list<${graphValueTypeLabel(type.element)}>`;
  }
}

/** List nesting and the innermost element. */
export function graphValueTypeElement(type: GraphValueType): {
  element: Exclude<GraphValueType, { kind: "list" }>;
  listDepth: number;
} {
  let listDepth = 0;
  let current = type;
  while (current.kind === "list") {
    current = current.element;
    listDepth++;
  }
  return { element: current, listDepth };
}

// --------------------------------------------------------------- schemas

const nullable = (schema: GraphJsonSchema): GraphJsonSchema => ({
  anyOf: [schema, { type: "null" }],
});

const stringField = (description: string): GraphJsonSchema => ({ type: "string", description });

function objectSchema(
  properties: Record<string, GraphJsonSchema>,
  description?: string,
): GraphJsonSchema {
  return {
    type: "object",
    ...(description ? { description } : {}),
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

const REVIEW_ISSUE_SCHEMA = (
  STRUCTURED_REVIEW_REPORT_JSON_SCHEMA.properties.issues as { items: GraphJsonSchema }
).items;

/** Rolled-up CI state of `check-summary@1` (D20). */
export const GRAPH_CHECK_SUMMARY_STATES = ["passed", "failed", "pending", "none"] as const;
export type GraphCheckSummaryState = (typeof GRAPH_CHECK_SUMMARY_STATES)[number];

/** Outcome of a `run-validation` system node (`validation-results@1`, report §9.4). */
export const GRAPH_VALIDATION_RESULT_STATES = ["passed", "failed", "incomplete"] as const;
export type GraphValidationResultState = (typeof GRAPH_VALIDATION_RESULT_STATES)[number];
/** How a command in `validation-results@1`'s `failures` ended. */
export const GRAPH_VALIDATION_FAILURE_STATES = ["failed", "incomplete"] as const;

/** The payload of `validation-results@1`. */
export interface GraphValidationResultsV1 {
  headRef: string;
  state: GraphValidationResultState;
  total: number;
  passed: number;
  failures: Array<{
    id: string;
    command: string;
    state: (typeof GRAPH_VALIDATION_FAILURE_STATES)[number];
    exitCode: number | null;
    summary: string;
    output: string;
  }>;
  limitations: string[];
}

/** Check conclusions `check-summary@1` lists as failing. */
export const GRAPH_FAILING_CHECK_CONCLUSIONS = [
  "failure",
  "cancelled",
  "timed-out",
  "action-required",
  "stale",
] as const;

/** Why a node's routed failure (`error@1`) happened. */
export const GRAPH_ERROR_CAUSES = [
  ...GRAPH_RETRY_CAUSES,
  "guard-violation",
  "budget-exceeded",
  "system-error",
] as const;
export type GraphErrorCause = (typeof GRAPH_ERROR_CAUSES)[number];

/** The PR monitor's rolled-up state as `check-summary@1` states it. */
export function graphCheckSummaryState(
  state: GitHubPullRequestChecksState,
): GraphCheckSummaryState {
  switch (state) {
    case "success":
    case "neutral":
      return "passed";
    case "failure":
      return "failed";
    case "pending":
      return "pending";
    case "none":
      return "none";
  }
}

/** `decision@1`'s schema, with `choice` limited to the port's choices when given. */
export function graphDecisionSchema(choices?: readonly string[]): GraphJsonSchema {
  return objectSchema({
    choice:
      choices && choices.length > 0
        ? { type: "string", enum: [...choices], description: "The option chosen." }
        : stringField("The option chosen, one of those the node offers."),
    rationale: stringField("Why this option, in one or two sentences."),
  });
}

/** The payload of `ticket@1`. */
export interface GraphTicketV1 {
  title: string;
  kind: TicketKind | null;
  description: string;
  criteria: Array<{ id: string; text: string }>;
  comments: Array<{ text: string }>;
}

/**
 * A pipeline's task snapshot as `ticket@1`. Criteria keep the ticket's ids
 * (derived as Verify derives them for snapshots without stored items); images
 * are not carried, because a value artifact cannot hold them.
 */
export function graphTicketFromTaskSnapshot(snapshot: TaskSnapshot): GraphTicketV1 {
  return {
    title: snapshot.title,
    kind: snapshot.kind ?? null,
    description: snapshot.description,
    criteria: taskSnapshotCriteria(snapshot).map(({ id, text }) => ({ id, text })),
    comments: snapshot.comments.map(({ text }) => ({ text })),
  };
}

// ------------------------------------------------------------- built-ins

const SHA_A = "3f2b8c1d9e7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c";
const SHA_B = "9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b";
const PACKAGE_SHA = "5b1d0f7e2c9a8b3d4e6f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d";

const EXAMPLE_ISSUE = {
  severity: "P1",
  confidence: 90,
  category: "correctness",
  title: "CSV export drops the last row",
  file: "src/reports/export.ts",
  line: 42,
  symbol: "exportCsv",
  description: "The loop stops one row early, so every export loses its final record.",
  evidence: "`for (let i = 0; i < rows.length - 1; i++)` skips rows[rows.length - 1].",
  suggestion: "Iterate to rows.length.",
  verification: "Run bun test src/reports/export.test.ts with a three-row fixture.",
  alternativeFixes: null,
  reviewModels: null,
  reviewSourceIds: null,
};

const EXAMPLE_REVIEW_REPORT = {
  reviewScope: {
    targetBranch: "main",
    baseRef: `${SHA_B}..${SHA_A}`,
    commit: { sha: SHA_A, subject: "Add CSV export to the reports page" },
    filesReviewed: ["src/reports/export.ts", "src/reports/export.test.ts"],
    filesSkipped: [],
    filesLeftUncommitted: [],
    commandsRun: [
      { command: "bun test src/reports", result: "passed", summary: "12 tests passed." },
    ],
    commandsNotRun: [],
    limitations: [],
  },
  whatChanged: {
    overview: "Adds a CSV export button to the reports page so users can download report rows.",
    before: "Reports could only be viewed in the browser.",
    after: "Reports can be downloaded as CSV with a header row.",
    keyCodeChanges: [
      {
        file: "src/reports/export.ts",
        line: 12,
        description: "exportCsv serialises rows with escaped fields.",
      },
    ],
    userImpact: "Users of the reports page can export data for spreadsheets.",
  },
  riskProfile: {
    changeTypes: ["feature"],
    riskAreas: ["data-export"],
    overallRisk: "low",
    reasoning: "A new, isolated code path with tests.",
  },
  testResults: { total: 12, passed: 12, failed: 0, notRun: 0, failures: [] },
  strengths: [
    {
      description: "Fields are escaped per RFC 4180.",
      file: "src/reports/export.ts",
      line: 20,
    },
  ],
  issues: [EXAMPLE_ISSUE],
  testCoverageGaps: [
    {
      file: "src/reports/export.ts",
      untestedBehavior: "Exports of an empty report.",
      reviewModels: null,
      reviewSourceIds: null,
    },
  ],
  verdict: { ready: "with-fixes", reasoning: "One correctness bug loses data in every export." },
  summaryOfChange:
    "Adds CSV export to the reports page. The new exportCsv serialises the visible rows with escaped fields and a header row.",
  reviewSummary:
    "One high-confidence correctness issue: the last row is dropped. Tests pass but do not cover it.",
};

interface BuiltInSpec {
  name: GraphBuiltInTypeName;
  version: number;
  label: string;
  description: string;
  family: GraphTypeFamily;
  schema: GraphJsonSchema;
  storage?: "value" | "reference";
  budgets: ArtifactTypeBudgets;
  items?: { path: string; idPrefix: string };
  itemType?: string;
  sharedFields?: string[];
  sources?: string[];
  render: { markdown?: string; summary?: string[] };
  example: unknown;
  validator?: GraphBuiltInValidatorId;
  resultKind?: WorkflowResultKind;
  formatter?: GraphTypeFormatter;
}

const BUILT_IN_SPECS: readonly BuiltInSpec[] = [
  {
    name: "text",
    version: 1,
    label: "Text",
    description: "Plain text.",
    family: "text",
    schema: objectSchema({ text: stringField("The text.") }),
    budgets: { maxBytes: 64 * KIB, maxStringBytes: 64 * KIB },
    render: { markdown: "{{text}}", summary: ["text"] },
    example: { text: "Export reports as CSV, including the header row." },
  },
  {
    name: "markdown",
    version: 1,
    label: "Markdown",
    description: "A Markdown document.",
    family: "text",
    schema: objectSchema({ markdown: stringField("The document, as Markdown.") }),
    budgets: { maxBytes: 128 * KIB, maxStringBytes: 128 * KIB },
    render: { markdown: "{{markdown}}" },
    example: { markdown: "## CSV export\n\n- Adds a download button\n- Escapes every field\n" },
  },
  {
    name: "ticket",
    version: 1,
    label: "Ticket",
    description:
      "A ticket as a pipeline snapshots it: title, kind, description, acceptance criteria with ids, and comments.",
    family: "ticket",
    schema: objectSchema({
      title: stringField("The ticket title."),
      kind: nullable({ type: "string", enum: [...TICKET_KINDS] }),
      description: stringField("The ticket description, as Markdown."),
      criteria: {
        type: "array",
        description: "Acceptance criteria with the ticket's own ids.",
        items: objectSchema({ id: { type: "string" }, text: { type: "string" } }),
      },
      comments: { type: "array", items: objectSchema({ text: { type: "string" } }) },
    }),
    budgets: { maxBytes: 256 * KIB, maxStringBytes: 128 * KIB, maxItems: 200 },
    render: {
      markdown:
        "# {{title}}\n\n{{description}}\n\n## Acceptance criteria\n\n{{#criteria}}- {{id}}: {{text}}\n{{/criteria}}",
      summary: ["title"],
    },
    example: {
      title: "Add CSV export to the reports page",
      kind: "feature",
      description: "Users need to take report data into spreadsheets.",
      criteria: [
        { id: "ac-1", text: "The reports page has an Export CSV button." },
        { id: "ac-2", text: "The CSV has a header row and every visible row." },
      ],
      comments: [{ text: "Match the column order on screen." }],
    } satisfies GraphTicketV1,
    validator: "ticket-sections",
  },
  {
    name: "workspace",
    version: 1,
    label: "Workspace",
    description:
      "A git snapshot of the run's environment: the branch and the commit a node left (D8).",
    family: "workspace",
    schema: objectSchema({
      branch: stringField("The branch."),
      headRef: stringField("The full commit SHA the node left."),
      baseRef: {
        ...nullable({ type: "string" }),
        description: "The commit the work started from.",
      },
    }),
    budgets: { maxBytes: 4 * KIB, maxStringBytes: 1 * KIB },
    render: { markdown: "Branch `{{branch}}` at `{{headRef}}`", summary: ["branch", "headRef"] },
    example: { branch: "feature/csv-export", headRef: SHA_A, baseRef: SHA_B },
    validator: "workspace-commit",
  },
  {
    name: "validation-plan",
    version: 1,
    label: "Validation plan",
    description: "The repository's validation commands for one commit, in dependency order.",
    family: "report",
    schema: REVIEW_VALIDATION_PLAN_SCHEMA,
    budgets: { maxBytes: 24_000, maxItems: 32 },
    items: { path: "commands", idPrefix: "command" },
    render: {
      markdown: "{{#commands}}- `{{command}}` in `{{cwd}}`\n{{/commands}}",
      summary: ["headRef"],
    },
    example: {
      headRef: SHA_A,
      commands: [
        {
          id: "typecheck",
          command: "bun run typecheck",
          cwd: ".",
          dependsOn: [],
          resources: [],
          weight: 1,
          timeoutMs: 600_000,
        },
        {
          id: "test",
          command: "bun test src/reports",
          cwd: ".",
          dependsOn: ["typecheck"],
          resources: [],
          weight: 2,
          timeoutMs: 900_000,
        },
      ],
      limitations: [],
    },
    validator: "validation-plan",
    resultKind: "validation-plan",
  },
  {
    name: "validation-results",
    version: 1,
    label: "Validation results",
    description:
      "What running a validation plan found, without sealing a package: the commit, the outcome and each failing command with the tail of its output (report §9.4).",
    family: "report",
    schema: objectSchema({
      headRef: stringField("The full commit SHA the commands ran against."),
      state: {
        type: "string",
        enum: [...GRAPH_VALIDATION_RESULT_STATES],
        description:
          "passed: no command failed; failed: at least one did; incomplete: stopped before every command finished.",
      },
      total: { type: "integer", minimum: 0, description: "Commands in the plan." },
      passed: { type: "integer", minimum: 0, description: "Commands that passed." },
      failures: {
        type: "array",
        description: "Commands that failed or did not finish, in plan order.",
        items: objectSchema({
          id: stringField("The command's id in the validation plan."),
          command: stringField("The command as run."),
          state: { type: "string", enum: [...GRAPH_VALIDATION_FAILURE_STATES] },
          exitCode: nullable({ type: "integer" }),
          summary: stringField("One line: how the command ended."),
          output: stringField("The tail of the command's output, stderr after stdout."),
        }),
      },
      limitations: { type: "array", items: { type: "string" } },
    }),
    budgets: { maxBytes: VALUE_CAP, maxStringBytes: 32 * KIB, maxItems: 64 },
    items: { path: "failures", idPrefix: "failure" },
    render: {
      markdown:
        "Validation **{{state}}**: {{passed}} of {{total}} passed at `{{headRef}}`\n\n{{#failures}}- `{{command}}`: {{summary}}\n{{/failures}}",
      summary: ["state", "passed", "total"],
    },
    example: {
      headRef: SHA_A,
      state: "failed",
      total: 2,
      passed: 1,
      failures: [
        {
          id: "test",
          command: "bun test src/reports",
          state: "failed",
          exitCode: 1,
          summary: "Exited with code 1",
          output: "export.test.ts:\n✗ exports every row\n  expected 3 rows, received 2\n",
        },
      ],
      limitations: [],
    } satisfies GraphValidationResultsV1,
    validator: "validation-results",
  },
  {
    name: "review-package",
    version: 2,
    label: "Review package",
    description:
      "A sealed review package in the environment, by reference: the diff, validation output and context a reviewer reads.",
    family: "package",
    storage: "reference",
    schema: objectSchema({
      kind: { type: "string", const: "file" },
      id: { type: "string" },
      round: { type: "integer", minimum: 1 },
      preparedAt: { type: "string" },
      targetBranch: { type: "string" },
      baseRef: { type: "string" },
      headRef: { type: "string" },
      filePath: { type: "string" },
      sha256: { type: "string" },
      bytes: { type: "integer", minimum: 1 },
      changedFileCount: { type: "integer", minimum: 0 },
      limitations: { type: "array", items: { type: "string" } },
    }),
    budgets: { maxBytes: REVIEW_PACKAGE_MAX_BYTES, maxItems: 128 },
    render: {
      markdown: "Review package `{{id}}` ({{changedFileCount}} files) at `{{filePath}}`",
      summary: ["targetBranch", "changedFileCount"],
    },
    example: {
      kind: "file",
      id: "review-csv-export",
      round: 1,
      preparedAt: "2026-10-29T09:00:00.000Z",
      targetBranch: "main",
      baseRef: SHA_B,
      headRef: SHA_A,
      filePath: reviewPackageArtifactPath("review-csv-export", PACKAGE_SHA),
      sha256: PACKAGE_SHA,
      bytes: 48_213,
      changedFileCount: 2,
      limitations: [],
    },
    validator: "review-package-reference",
  },
  {
    name: "review-report",
    version: 1,
    label: "Review report",
    description:
      "A structured code review: scope, what changed, risk, test results, findings and a verdict.",
    family: "report",
    schema: STRUCTURED_REVIEW_REPORT_JSON_SCHEMA as unknown as GraphJsonSchema,
    budgets: {
      maxBytes: VALUE_CAP,
      maxStringBytes: STRUCTURED_REVIEW_MAX_TEXT_BYTES,
      maxItems: STRUCTURED_REVIEW_MAX_FILES_REVIEWED,
    },
    items: { path: "issues", idPrefix: "issue" },
    itemType: "finding@1",
    // What `buildConsolidationEvidence` hoists when every reviewer agrees.
    sharedFields: [
      "reviewScope.targetBranch",
      "reviewScope.baseRef",
      "reviewScope.commit",
      "reviewScope.filesReviewed",
      "reviewScope.commandsRun",
      "reviewScope.commandsNotRun",
      "testResults",
    ],
    sources: ["issues[].reviewSourceIds", "testCoverageGaps[].reviewSourceIds"],
    render: {
      markdown:
        "**Verdict:** {{verdict.ready}}. {{verdict.reasoning}}\n\n{{reviewSummary}}\n\n## Issues\n\n{{#issues}}- **{{severity}}** {{title}} ({{file}})\n{{/issues}}",
      summary: ["verdict.ready", "riskProfile.overallRisk", "reviewSummary"],
    },
    example: EXAMPLE_REVIEW_REPORT,
    validator: "structured-review-report",
    resultKind: "review-report",
    formatter: "structured-review-report",
  },
  {
    name: "finding",
    version: 1,
    label: "Finding",
    description: "One review issue, as a review report lists it.",
    family: "report",
    schema: REVIEW_ISSUE_SCHEMA,
    // A finding may be any issue of a valid report, so it shares the report's caps.
    budgets: {
      maxBytes: VALUE_CAP,
      maxStringBytes: STRUCTURED_REVIEW_MAX_TEXT_BYTES,
      maxItems: STRUCTURED_REVIEW_MAX_SOURCE_IDS,
    },
    sources: ["reviewSourceIds"],
    render: {
      markdown: "**{{severity}}** {{title}} ({{file}})\n\n{{description}}\n\n{{suggestion}}",
      summary: ["severity", "title", "file"],
    },
    example: EXAMPLE_ISSUE,
    validator: "review-finding",
  },
  {
    name: "verification-verdict",
    version: 1,
    label: "Verification verdict",
    description: "Whether the work meets the ticket, with a result per acceptance criterion.",
    family: "report",
    schema: VERIFICATION_VERDICT_SCHEMA,
    budgets: { maxBytes: VALUE_CAP, maxItems: TICKET_SECTION_LIMITS.maxAcceptanceCriteria },
    items: { path: "acceptanceCriteria", idPrefix: "criterion" },
    render: {
      markdown:
        "**Complete:** {{complete}}\n\n{{rationale}}\n\n{{#acceptanceCriteria}}- {{id}}: {{status}}. {{evidence}}\n{{/acceptanceCriteria}}",
      summary: ["complete", "rationale"],
    },
    example: {
      complete: false,
      rationale: "The export works but drops the last row.",
      acceptanceCriteria: [
        { id: "ac-1", status: "passed", evidence: "The button renders and downloads a file." },
        { id: "ac-2", status: "failed", evidence: "A three-row report exports two rows." },
      ],
    },
    validator: "verification-verdict",
    resultKind: "verification-result",
  },
  {
    name: "fix-result",
    version: 1,
    label: "Fix result",
    description: "What a fixing or building node changed and validated, and whether it finished.",
    family: "report",
    schema: REVIEW_FIX_RESULT_JSON_SCHEMA,
    budgets: { maxBytes: VALUE_CAP, maxItems: 10_000 },
    render: {
      markdown:
        "**Complete:** {{complete}}\n\n{{summary}}\n\n{{#commandsRun}}- `{{command}}`: {{result}}\n{{/commandsRun}}",
      summary: ["complete", "summary"],
    },
    example: {
      complete: true,
      summary: "Fixed the off-by-one in exportCsv and added a three-row test.",
      filesChanged: ["src/reports/export.ts", "src/reports/export.test.ts"],
      commandsRun: [
        { command: "bun test src/reports", result: "passed", summary: "13 tests passed." },
      ],
      notes: [],
      limitations: [],
    },
    validator: "fix-result",
    resultKind: "fix-result",
  },
  {
    name: "pr-result",
    version: 1,
    label: "Pull request",
    description: "A pull request the run opened.",
    family: "report",
    schema: REVIEW_PR_RESULT_JSON_SCHEMA,
    budgets: { maxBytes: 16 * KIB },
    render: { markdown: "[{{url}}]({{url}}): {{summary}}", summary: ["url"] },
    example: {
      status: "created",
      url: "https://github.com/acme/widgets/pull/42",
      summary: "Opened the CSV export pull request against main.",
    },
    validator: "pr-result",
    resultKind: "pr-result",
  },
  {
    name: "pr-description",
    version: 1,
    label: "Pull request description",
    description: "The title and body an agent wrote for a pull request a system node opens (D12).",
    family: "text",
    schema: objectSchema({
      title: stringField("One line, at most 256 characters."),
      body: stringField("The pull request body, as Markdown."),
    }),
    budgets: { maxBytes: 128 * KIB, maxStringBytes: 64 * KIB },
    render: { markdown: "# {{title}}\n\n{{body}}", summary: ["title"] },
    example: {
      title: "Add CSV export to the reports page",
      body: "## Summary\n\n- Adds an Export CSV button\n- Escapes fields per RFC 4180\n",
    },
    validator: "pr-description",
  },
  {
    name: "check-summary",
    version: 1,
    label: "Check summary",
    description:
      "CI checks on a pull request's head commit, rolled up, with the failing checks (D20).",
    family: "report",
    schema: objectSchema({
      state: { type: "string", enum: [...GRAPH_CHECK_SUMMARY_STATES] },
      headRef: nullable({ type: "string" }),
      total: { type: "integer", minimum: 0 },
      pending: { type: "integer", minimum: 0 },
      failing: {
        type: "array",
        items: objectSchema({
          name: { type: "string" },
          conclusion: { type: "string", enum: [...GRAPH_FAILING_CHECK_CONCLUSIONS] },
          detailsUrl: nullable({ type: "string" }),
          summary: nullable({ type: "string" }),
        }),
      },
    }),
    budgets: { maxBytes: 64 * KIB, maxStringBytes: 4 * KIB, maxItems: 256 },
    items: { path: "failing", idPrefix: "check" },
    render: {
      markdown: "Checks: **{{state}}**\n\n{{#failing}}- {{name}}: {{conclusion}}\n{{/failing}}",
      summary: ["state", "total", "pending"],
    },
    example: {
      state: "failed",
      headRef: SHA_A,
      total: 3,
      pending: 0,
      failing: [
        {
          name: "test (ubuntu-latest)",
          conclusion: "failure",
          detailsUrl: "https://github.com/acme/widgets/actions/runs/1",
          summary: "1 test failed",
        },
      ],
    },
    validator: "check-summary",
  },
  {
    name: "decision",
    version: 1,
    label: "Decision",
    description: "A choice among options the producing port declares, with a rationale.",
    family: "decision",
    schema: graphDecisionSchema(),
    budgets: { maxBytes: 16 * KIB, maxStringBytes: 8 * KIB },
    render: { markdown: "**{{choice}}**: {{rationale}}", summary: ["choice"] },
    example: { choice: "simplicity", rationale: "It solves the ticket with the smallest change." },
    validator: "decision-choice",
  },
  {
    name: "file-list",
    version: 1,
    label: "File list",
    description: "Repository-relative paths, each with the reason it is listed.",
    family: "report",
    schema: objectSchema({
      files: {
        type: "array",
        items: objectSchema({
          path: stringField("Relative to the worktree root."),
          reason: stringField("Why the file is listed."),
        }),
      },
    }),
    budgets: { maxBytes: 256 * KIB, maxStringBytes: 4 * KIB, maxItems: 10_000 },
    items: { path: "files", idPrefix: "file" },
    render: { markdown: "{{#files}}- `{{path}}`: {{reason}}\n{{/files}}" },
    example: {
      files: [
        { path: "src/reports/export.ts", reason: "Builds the CSV." },
        { path: "src/reports/ReportsPage.tsx", reason: "Hosts the export button." },
      ],
    },
    validator: "file-list-paths",
  },
  {
    name: "error",
    version: 1,
    label: "Error",
    description: "A node failure routed to its error port (`onFailure: route`).",
    family: "error",
    schema: objectSchema({
      node: stringField("The failed node's id."),
      cause: { type: "string", enum: [...GRAPH_ERROR_CAUSES] },
      code: stringField("A stable error code."),
      message: stringField("What went wrong, without payload content."),
      attempts: { type: "integer", minimum: 1 },
      retryable: { type: "boolean" },
    }),
    budgets: { maxBytes: 16 * KIB, maxStringBytes: 4 * KIB },
    render: {
      markdown: "Node `{{node}}` failed ({{cause}}, {{code}}): {{message}}",
      summary: ["node", "cause", "code"],
    },
    example: {
      node: "review",
      cause: "timeout",
      code: "activation_timeout",
      message: "The activation did not finish within 30 minutes.",
      attempts: 2,
      retryable: true,
    },
  },
];

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function sourcesFields(paths: readonly string[] | undefined): GraphSchemaSourcesField[] {
  return (paths ?? []).map((path) => ({
    path,
    segments: path
      .split(".")
      .flatMap((segment) => (segment.endsWith("[]") ? [segment.slice(0, -2), "[]"] : [segment])),
  }));
}

function builtInDefinition(spec: BuiltInSpec): GraphBuiltInTypeDefinition {
  // Cloned so freezing the library never freezes a schema the backend shares.
  const definition: GraphBuiltInTypeDefinition = {
    name: spec.name,
    version: spec.version,
    ref: `${spec.name}@${spec.version}`,
    builtIn: true,
    label: spec.label,
    description: spec.description,
    family: spec.family,
    schema: structuredClone(spec.schema),
    storage: spec.storage ?? "value",
    budgets: { ...spec.budgets },
    ...(spec.items ? { items: { ...spec.items } } : {}),
    ...(spec.itemType ? { itemType: spec.itemType } : {}),
    ...(spec.sharedFields ? { sharedFields: [...spec.sharedFields] } : {}),
    sources: sourcesFields(spec.sources),
    render: structuredClone(spec.render),
    example: structuredClone(spec.example),
    ...(spec.validator ? { validator: spec.validator } : {}),
    ...(spec.resultKind ? { resultKind: spec.resultKind } : {}),
    ...(spec.formatter ? { formatter: spec.formatter } : {}),
  };
  return deepFreeze(definition);
}

const BUILT_INS: readonly GraphBuiltInTypeDefinition[] = Object.freeze(
  BUILT_IN_SPECS.map(builtInDefinition),
);
const BUILT_IN_BY_REF = new Map(BUILT_INS.map((definition) => [definition.ref, definition]));
const BUILT_IN_NAMES: ReadonlySet<string> = new Set(GRAPH_BUILT_IN_TYPE_NAMES);

/** Every built-in type, frozen. */
export function graphBuiltInTypes(): readonly GraphBuiltInTypeDefinition[] {
  return BUILT_INS;
}

/** A built-in type by `name@version`. */
export function graphBuiltInType(ref: string): GraphBuiltInTypeDefinition | undefined {
  return BUILT_IN_BY_REF.get(ref);
}

export function isGraphBuiltInTypeName(name: unknown): name is GraphBuiltInTypeName {
  return typeof name === "string" && BUILT_IN_NAMES.has(name);
}

// ---------------------------------------------------------------- custom

/**
 * A custom type as the library holds it. The template guard has already
 * checked it (`checkArtifactTypeDef`); provenance fields come from its schema.
 */
export function graphCustomTypeDefinition(def: ArtifactTypeDef): GraphTypeDefinition {
  const subset = validateGraphSchemaSubset(def.schema);
  return {
    ...def,
    ref: `${def.name}@${def.version}`,
    builtIn: false,
    family: def.storage === "reference" ? "package" : "report",
    sources: subset.ok ? subset.value.sources : [],
  };
}

export type GraphTypeResolution =
  | { ok: true; type: GraphValueType }
  | { ok: false; code: "type_ref" | "unknown_type" | "unknown_version"; message: string };

/**
 * Resolves type references for one template: the built-ins plus its custom
 * types. A custom type that reuses a built-in name is ignored (the template
 * guard rejects it) and listed in `conflicts`.
 */
export class GraphTypeLibrary {
  private readonly custom = new Map<string, GraphTypeDefinition>();
  readonly conflicts: string[] = [];

  constructor(customTypes: readonly ArtifactTypeDef[] = []) {
    for (const def of customTypes) {
      const ref = `${def.name}@${def.version}`;
      if (isGraphBuiltInTypeName(def.name) || this.custom.has(ref)) {
        this.conflicts.push(ref);
        continue;
      }
      this.custom.set(ref, graphCustomTypeDefinition(def));
    }
  }

  /** A type by name and major version. */
  definition(name: string, version: number): GraphTypeDefinition | undefined {
    const ref = `${name}@${version}`;
    return BUILT_IN_BY_REF.get(ref) ?? this.custom.get(ref);
  }

  /** Built-ins first, then custom types in declaration order. */
  definitions(): GraphTypeDefinition[] {
    return [...BUILT_INS, ...this.custom.values()];
  }

  /** Resolve `name@major` or `list<…>`. */
  resolve(ref: string): GraphTypeResolution {
    const parts = parseGraphTypeRef(ref);
    if (!parts) {
      return { ok: false, code: "type_ref", message: `"${ref}" is not a type reference` };
    }
    const definition = this.definition(parts.name, parts.version);
    if (!definition) {
      const known = this.definitions().filter((entry) => entry.name === parts.name);
      return known.length > 0
        ? {
            ok: false,
            code: "unknown_version",
            message: `${parts.name} has no version ${parts.version} (known: ${known.map((entry) => entry.ref).join(", ")})`,
          }
        : { ok: false, code: "unknown_type", message: `Unknown type ${parts.name}` };
    }
    let type: GraphValueType = { kind: "named", definition };
    for (let depth = 0; depth < parts.listDepth; depth++) type = { kind: "list", element: type };
    return { ok: true, type };
  }
}

const DEFAULT_LIBRARY = new GraphTypeLibrary();

/**
 * The designer's port colour for a type reference. Lists are `list`; an
 * unresolvable reference is `unknown`. Custom types are `report`, or
 * `package` when stored by reference.
 */
export function graphTypeFamily(ref: string, library?: GraphTypeLibrary): GraphTypeFamily {
  const parts = parseGraphTypeRef(ref);
  if (!parts) return "unknown";
  if (parts.listDepth > 0) return "list";
  const definition = (library ?? DEFAULT_LIBRARY).definition(parts.name, parts.version);
  return definition?.family ?? "unknown";
}

// ------------------------------------------------------------- validation

const MAX_ISSUES = 32;

function issue(path: string, code: string, message: string): WorkflowResultValidationIssue {
  return { path: path.slice(0, 256), code, message: message.slice(0, 512) };
}

/**
 * Budget violations of a value: serialized bytes against `maxBytes` (for a
 * reference type, the value is the descriptor and is held to the value cap;
 * the sealed file's size is checked where it is sealed), every string against
 * `maxStringBytes` and every array against `maxItems`. Messages carry numbers
 * and paths only, never content.
 */
export function graphBudgetIssues(
  budgets: ArtifactTypeBudgets,
  value: unknown,
  storage: "value" | "reference" = "value",
): WorkflowResultValidationIssue[] {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return [issue("$", "invalid_value", "The value is not JSON")];
  }
  if (encoded === undefined) return [issue("$", "invalid_value", "The value is not JSON")];
  const maxBytes = storage === "reference" ? VALUE_CAP : budgets.maxBytes;
  const bytes = graphUtf8Bytes(encoded);
  if (bytes > maxBytes) {
    return [issue("$", "too_large", `The value is ${bytes} bytes; the limit is ${maxBytes}`)];
  }
  const issues: WorkflowResultValidationIssue[] = [];
  const stack: Array<[unknown, string]> = [[value, "$"]];
  while (stack.length > 0 && issues.length < MAX_ISSUES) {
    const [current, path] = stack.pop()!;
    if (typeof current === "string") {
      if (budgets.maxStringBytes !== undefined) {
        const size = graphUtf8Bytes(current);
        if (size > budgets.maxStringBytes) {
          issues.push(
            issue(
              path,
              "too_large",
              `Text is ${size} bytes; the limit is ${budgets.maxStringBytes}`,
            ),
          );
        }
      }
    } else if (Array.isArray(current)) {
      if (budgets.maxItems !== undefined && current.length > budgets.maxItems) {
        issues.push(
          issue(
            path,
            "too_many_items",
            `The list has ${current.length} items; the limit is ${budgets.maxItems}`,
          ),
        );
      }
      for (let index = current.length - 1; index >= 0; index--) {
        stack.push([current[index], `${path}[${index}]`]);
      }
    } else if (current !== null && typeof current === "object") {
      for (const [key, child] of Object.entries(current).reverse()) {
        stack.push([child, `${path}.${key}`]);
      }
    }
  }
  return issues;
}

/**
 * The one check every artifact passes when it is produced (invariant 4):
 * budgets, then the schema, then the built-in domain validator. The backend's
 * extra checks (`GraphBuiltInValidator.backend`) run on top in item 103.
 * `context.choices` also narrows a decision's schema.
 */
export function validateGraphArtifactValue(
  definition: GraphTypeDefinition,
  value: unknown,
  context: GraphTypeValidationContext = {},
): WorkflowResultValidationIssue[] {
  const budget = graphBudgetIssues(definition.budgets, value, definition.storage);
  if (budget.length > 0) return budget;
  const schema =
    definition.builtIn && definition.name === "decision" && context.choices
      ? graphDecisionSchema(context.choices)
      : definition.schema;
  const structural = validateGraphSchemaValue(schema, value);
  if (structural.length > 0) return structural;
  if (!definition.validator) return [];
  return graphBuiltInValidator(definition.validator).check(value, context).slice(0, MAX_ISSUES);
}
