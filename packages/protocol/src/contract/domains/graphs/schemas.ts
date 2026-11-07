/**
 * Result shapes of the `graphs` commands (plan item 7007), over the protocol's
 * own graph types (`graphs/library.ts`, `sharing.ts`, `describe.ts`,
 * `launch.ts`, `run-view.ts`, `run-rewind.ts`, `run-human.ts`).
 *
 * Records are {@link modelRecord}s: the fields that identify a record and the
 * ones a reader branches on are checked, and every other key passes through,
 * typed as the protocol's interface. Deeper parts (plans, diagnostics,
 * activations, layouts) stay open objects.
 *
 * **The graph guards.** Templates and runs already have strict hand-written
 * guards (`validateGraphTemplate`, `validateGraphRun`). They are reused, not
 * duplicated: {@link guardedRecord} runs the guard as a schema refinement.
 * The guards refuse any field they do not know (`checkObject`) and any value
 * outside a closed list (`checkEnum`), which in a client's decode would refuse
 * a newer backend's added field or status: so the refinement fails only on
 * the guard's other errors, and tolerates {@link FORWARD_COMPATIBLE_GUARD_CODES}.
 * The run guard runs without its plan digest check (`verifyPlan`), which is
 * the backend's integrity check on load, not a reader's.
 *
 * Values a newer backend may extend (statuses, trust states, kinds) are
 * `Schema.String` unless a union branches on them.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import type { GraphCapabilityCeiling } from "../../../graphs/capability-profiles.js";
import type { GraphDescribeJobView } from "../../../graphs/describe.js";
import type { GraphLaunchOptions, GraphLaunchResult } from "../../../graphs/launch.js";
import type {
  GraphProjectCeiling,
  GraphProjectTemplateSource,
  GraphTemplateCompileResponse,
  GraphTemplateCompileSummary,
  GraphTemplateDetail,
  GraphTemplateExport,
  GraphTemplateImportResult,
  GraphTemplateRef,
  GraphTemplateSummary,
  GraphTemplatesListResult,
  GraphTemplateTrustResult,
} from "../../../graphs/library.js";
import type { GraphMockPins } from "../../../graphs/mock-pins.js";
import type { GraphAgentQuestion } from "../../../graphs/run-agent-session.js";
import { validateGraphRun } from "../../../graphs/run-guards.js";
import type {
  GraphHumanWait,
  GraphRunPendingHumanWait,
  GraphRunPendingInteraction,
  GraphRunPendingQuestion,
} from "../../../graphs/run-human.js";
import type {
  GraphArtifact,
  GraphArtifactFile,
  GraphRewind,
  GraphRun,
  GraphRunTemplateRef,
  GraphRunUsage,
} from "../../../graphs/run-model.js";
import type {
  GraphRunCodeRewindPreview,
  GraphRunRestartResult,
} from "../../../graphs/run-rewind.js";
import type {
  GraphRunArtifactView,
  GraphRunGetResult,
  GraphRunSummary,
  GraphRunTranscriptView,
} from "../../../graphs/run-view.js";
import type {
  GraphProjectTemplateReview,
  GraphProjectTemplateReviewDecision,
  GraphProjectTemplateReviewItem,
  GraphSharingKeys,
  GraphTemplateSharePreview,
  GraphTemplateShareExport,
  GraphTemplateShareImportResult,
} from "../../../graphs/sharing.js";
import { validateGraphTemplate, type GraphTemplateV1 } from "../../../graphs/template.js";
import type { FieldValidation } from "../../../field-validation.js";
import {
  asModel,
  modelRecord,
  type ModelSchema,
  mutableArray,
  opaqueRecord,
} from "../../model-schema.js";

// --------------------------------------------------------------- guards

/**
 * Guard error codes that mean "this reader is older than the record", not "the
 * record is broken": a field the guard does not list (`unknown_field`) and a
 * value outside one of its closed lists (`enum`, such as a newer run status).
 */
export const FORWARD_COMPATIBLE_GUARD_CODES: ReadonlySet<string> = new Set([
  "unknown_field",
  "enum",
]);

/**
 * The guard's verdict for a reader: `true`, or the first error that is not a
 * forward-compatible addition, as `path: message`. A guard stops at its error
 * cap; when every reported error is tolerated the record passes.
 */
export function tolerantGuardVerdict(validation: FieldValidation<unknown>): true | string {
  if (validation.ok) return true;
  const blocking = validation.errors.find(
    (error) => !FORWARD_COMPATIBLE_GUARD_CODES.has(error.code),
  );
  if (!blocking) return true;
  return blocking.path ? `${blocking.path}: ${blocking.message}` : blocking.message;
}

/** `record`, refined by a protocol guard read tolerantly ({@link tolerantGuardVerdict}). */
export function guardedRecord<T>(
  record: ModelSchema<T>,
  validate: (value: unknown) => FieldValidation<unknown>,
  expected: string,
): ModelSchema<T> {
  return record.check(
    Schema.makeFilter((value: T) => tolerantGuardVerdict(validate(value)), { expected }),
  ) as ModelSchema<T>;
}

// --------------------------------------------------------------- shared parts

const optionalString = Schema.optional(Schema.String);

const StringArray = mutableArray(Schema.String);
const OpenObject = opaqueRecord<Record<string, unknown>>();
const OpenObjects = Schema.Array(OpenObject);

/** `GraphTemplateRef`: `{ scope, id }` or `{ scope: "project", projectId, path }`. */
export const GraphTemplateRefSchema = modelRecord<GraphTemplateRef>()({ scope: Schema.String });

/** `GraphCapabilityCeiling`: capabilities denied, and `web.search` allowed back. */
export const GraphCapabilityCeilingSchema = modelRecord<GraphCapabilityCeiling>()({
  deny: StringArray,
  allow: Schema.optional(StringArray),
});

/** `GraphTemplateV1`, refined by `validateGraphTemplate`. */
export const GraphTemplateSchema = guardedRecord(
  modelRecord<GraphTemplateV1>()({
    format: Schema.String,
    formatVersion: Schema.Finite,
    id: Schema.String,
    revision: Schema.Finite,
    name: Schema.String,
  }),
  validateGraphTemplate,
  "a graph template",
);

/** `GraphRun`, refined by `validateGraphRun` without the plan digest check. */
export const GraphRunSchema = guardedRecord(
  modelRecord<GraphRun>()({
    format: Schema.String,
    formatVersion: Schema.Finite,
    id: Schema.String,
    projectId: Schema.String,
    environmentId: optionalString,
    status: Schema.String,
    mock: Schema.Boolean,
    revision: Schema.Finite,
    activations: OpenObjects,
    createdAt: Schema.String,
    updatedAt: Schema.String,
  }),
  (value) => validateGraphRun(value, { verifyPlan: () => true }),
  "a graph run",
);

const RunTemplateRefSchema = modelRecord<GraphRunTemplateRef>()({
  id: Schema.String,
  revision: Schema.Finite,
  digest: Schema.String,
  scope: optionalString,
});

const RunUsageSchema = modelRecord<GraphRunUsage>()({
  agentSessions: Schema.Finite,
  tokens: Schema.Finite,
  cacheReadTokens: Schema.optional(Schema.Finite),
});

const DiagnosticSchema = modelRecord<{ code: string; severity: string; message: string }>()({
  code: Schema.String,
  severity: Schema.String,
  message: Schema.String,
});

const FieldErrorSchema = modelRecord<{ path: string; code: string; message: string }>()({
  path: Schema.String,
  code: Schema.String,
  message: Schema.String,
});

// --------------------------------------------------------------- library

export const GraphTemplateCompileSummarySchema = modelRecord<GraphTemplateCompileSummary>()({
  ok: Schema.Boolean,
  launchable: Schema.Boolean,
  errors: Schema.Finite,
  warnings: Schema.Finite,
  infos: Schema.Finite,
  pendingAcknowledgements: Schema.Finite,
  planDigest: Schema.NullOr(Schema.String),
  cost: Schema.NullOr(OpenObject),
});

export const GraphTemplateSummarySchema = modelRecord<GraphTemplateSummary>()({
  ref: GraphTemplateRefSchema,
  scope: Schema.String,
  id: Schema.String,
  name: Schema.String,
  description: optionalString,
  engine: optionalString,
  engineStatus: optionalString,
  revision: Schema.Finite,
  digest: Schema.String,
  readOnly: Schema.Boolean,
  trust: Schema.String,
  approvedAt: optionalString,
  launchable: Schema.Boolean,
  compile: GraphTemplateCompileSummarySchema,
  updatedAt: optionalString,
});

const ProjectTemplateSourceSchema = modelRecord<GraphProjectTemplateSource>()({
  projectId: Schema.String,
  status: Schema.String,
  directory: Schema.String,
  files: Schema.Finite,
  truncated: Schema.Boolean,
  problems: Schema.Array(
    modelRecord<{ path: string; code: string; message: string }>()({
      path: Schema.String,
      code: Schema.String,
      message: Schema.String,
    }),
  ),
});

/** `graph_templates_list`. */
export const GraphTemplatesListResultSchema = modelRecord<GraphTemplatesListResult>()({
  templates: Schema.Array(GraphTemplateSummarySchema),
  project: Schema.NullOr(ProjectTemplateSourceSchema),
  ceiling: GraphCapabilityCeilingSchema,
});

/** `graph_template_get`, `_save`, `_duplicate`. */
export const GraphTemplateDetailSchema = modelRecord<GraphTemplateDetail>()({
  summary: GraphTemplateSummarySchema,
  template: GraphTemplateSchema,
});

/** `graph_template_import`: refused text is an answer, not a throw. */
export const GraphTemplateImportResultSchema = asModel<GraphTemplateImportResult>(
  Schema.Union([
    Schema.Struct({
      ok: Schema.Literal(true),
      detail: GraphTemplateDetailSchema,
      renamedFrom: optionalString,
    }),
    Schema.Struct({
      ok: Schema.Literal(false),
      errors: Schema.Array(FieldErrorSchema),
      omittedErrors: Schema.Finite,
    }),
  ]),
);

/** `graph_template_compile`. */
export const GraphTemplateCompileResponseSchema = modelRecord<GraphTemplateCompileResponse>()({
  summary: Schema.NullOr(GraphTemplateSummarySchema),
  ok: Schema.Boolean,
  launchable: Schema.Boolean,
  blockedBy: optionalString,
  diagnostics: Schema.Array(DiagnosticSchema),
  omittedDiagnostics: Schema.Finite,
  cost: Schema.NullOr(OpenObject),
  pendingAcknowledgements: OpenObjects,
  planDigest: Schema.NullOr(Schema.String),
  plan: Schema.optional(Schema.NullOr(OpenObject)),
  ceiling: GraphCapabilityCeilingSchema,
});

/** `graph_template_export`. */
export const GraphTemplateExportSchema = modelRecord<GraphTemplateExport>()({
  fileName: Schema.String,
  text: Schema.String,
  digest: Schema.String,
});

/** `graph_template_delete`. */
export const GraphTemplateDeleteResultSchema = Schema.Struct({ deleted: Schema.Boolean });

/** `graph_template_trust`. */
export const GraphTemplateTrustResultSchema = modelRecord<GraphTemplateTrustResult>()({
  projectId: Schema.String,
  path: Schema.String,
  trust: Schema.String,
  digest: Schema.NullOr(Schema.String),
  approvedAt: optionalString,
  records: Schema.Array(
    modelRecord<{ path: string; digest: string; approvedAt: string }>()({
      path: Schema.String,
      digest: Schema.String,
      approvedAt: Schema.String,
    }),
  ),
});

/** `graph_capability_ceiling_get` and `_set`. */
export const GraphProjectCeilingSchema = modelRecord<GraphProjectCeiling>()({
  projectId: Schema.String,
  ceiling: GraphCapabilityCeilingSchema,
  isDefault: Schema.Boolean,
  revision: Schema.Finite,
  updatedAt: optionalString,
});

// --------------------------------------------------------------- sharing

/** `graph_template_share_export`. */
export const GraphTemplateShareExportSchema = modelRecord<GraphTemplateShareExport>()({
  fileName: Schema.String,
  text: Schema.String,
  digest: Schema.String,
  contentDigest: Schema.String,
  signed: Schema.Boolean,
  keyId: optionalString,
});

const SharePreviewSchema = modelRecord<GraphTemplateSharePreview>()({
  kind: Schema.String,
  integrity: Schema.String,
  digest: Schema.String,
  contentDigest: Schema.String,
  templateId: Schema.String,
  name: Schema.String,
  renameTo: optionalString,
  engineDropped: Schema.Boolean,
  compile: GraphTemplateCompileSummarySchema,
  capabilities: OpenObject,
});

/** `graph_template_share_import`: refused, a preview, or imported. */
export const GraphTemplateShareImportResultSchema = asModel<GraphTemplateShareImportResult>(
  Schema.Union([
    Schema.Struct({
      status: Schema.Literal("refused"),
      refused: Schema.String,
      errors: Schema.Array(FieldErrorSchema),
      omittedErrors: Schema.Finite,
    }),
    Schema.Struct({ status: Schema.Literal("preview"), preview: SharePreviewSchema }),
    Schema.Struct({
      status: Schema.Literal("imported"),
      preview: SharePreviewSchema,
      detail: GraphTemplateDetailSchema,
      renamedFrom: optionalString,
    }),
  ]),
);

/** `graph_sharing_keys` and `graph_sharing_key_trust`. */
export const GraphSharingKeysSchema = modelRecord<GraphSharingKeys>()({
  installation: Schema.NullOr(
    modelRecord<{ keyId: string; publicKey: string; createdAt: string }>()({
      keyId: Schema.String,
      publicKey: Schema.String,
      createdAt: Schema.String,
    }),
  ),
  trusted: Schema.Array(
    modelRecord<{ keyId: string; publicKey: string; label: string; addedAt: string }>()({
      keyId: Schema.String,
      publicKey: Schema.String,
      label: Schema.String,
      addedAt: Schema.String,
    }),
  ),
});

const ReviewItemSchema = modelRecord<GraphProjectTemplateReviewItem>()({
  ref: GraphTemplateRefSchema,
  path: Schema.String,
  templateId: Schema.String,
  name: Schema.String,
  trust: Schema.String,
  digest: Schema.String,
  compile: GraphTemplateCompileSummarySchema,
  capabilities: OpenObject,
  diff: Schema.NullOr(OpenObject),
});

/** `graph_project_template_review`. */
export const GraphProjectTemplateReviewSchema = modelRecord<GraphProjectTemplateReview>()({
  projectId: Schema.String,
  source: ProjectTemplateSourceSchema,
  items: Schema.Array(ReviewItemSchema),
});

/** `graph_project_template_review_decide`. */
export const GraphProjectTemplateReviewDecisionSchema =
  modelRecord<GraphProjectTemplateReviewDecision>()({
    projectId: Schema.String,
    path: Schema.String,
    digest: Schema.String,
    decision: Schema.String,
    trust: Schema.String,
    decidedAt: Schema.String,
  });

// --------------------------------------------------------------- describe

/** `GraphDescribeJobView`; a completed job's draft is a guarded template. */
export const GraphDescribeJobViewSchema = modelRecord<GraphDescribeJobView>()({
  id: Schema.String,
  environmentId: Schema.String,
  projectId: Schema.String,
  status: Schema.String,
  progress: optionalString,
  repairs: Schema.Finite,
  agent: Schema.String,
  model: optionalString,
  description: Schema.String,
  modifying: Schema.Boolean,
  template: Schema.optional(GraphTemplateSchema),
  error: optionalString,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  completedAt: optionalString,
});

export const NullableGraphDescribeJobViewSchema = Schema.NullOr(GraphDescribeJobViewSchema);

/** `graph_describe_dismiss`. */
export const GraphDescribeDismissResultSchema = Schema.Struct({ dismissed: Schema.Boolean });

// --------------------------------------------------------------- launch

/** `graph_launch_options`. */
export const GraphLaunchOptionsSchema = modelRecord<GraphLaunchOptions>()({
  summary: GraphTemplateSummarySchema,
  launchable: Schema.Boolean,
  blockedReason: optionalString,
  errors: Schema.Array(DiagnosticSchema),
  roles: OpenObjects,
  parameters: OpenObjects,
  params: Schema.Record(
    Schema.String,
    Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]),
  ),
  inputs: OpenObjects,
  environment: modelRecord<GraphLaunchOptions["environment"]>()({
    workspace: Schema.String,
    create: optionalString,
    default: Schema.String,
  }),
});

/** `graph_run_launch`. */
export const GraphLaunchResultSchema = modelRecord<GraphLaunchResult>()({
  runId: Schema.String,
  projectId: Schema.String,
  environmentId: optionalString,
  status: Schema.String,
  template: modelRecord<GraphLaunchResult["template"]>()({
    id: Schema.String,
    revision: Schema.Finite,
    name: Schema.String,
  }),
  repeated: Schema.Boolean,
});

// --------------------------------------------------------------- mock runs

/** The mock run as `graph_run_mock` returns it (`graph-mock-launch.ts`). */
export interface GraphMockLaunchRun {
  id: string;
  projectId: string;
  environmentId?: string;
  status: string;
  mock: true;
  template: GraphRunTemplateRef;
  createdAt: string;
}

/** `graph_run_mock`'s answer. */
export interface GraphMockLaunchResultShape {
  run: GraphMockLaunchRun;
  pins: GraphMockPins | null;
  exampleInputs: string[];
  placeholderRoles: string[];
}

export const GraphMockLaunchResultSchema = modelRecord<GraphMockLaunchResultShape>()({
  run: modelRecord<GraphMockLaunchRun>()({
    id: Schema.String,
    projectId: Schema.String,
    environmentId: optionalString,
    status: Schema.String,
    mock: Schema.Literal(true),
    template: RunTemplateRefSchema,
    createdAt: Schema.String,
  }),
  pins: Schema.NullOr(opaqueRecord<GraphMockPins>()),
  exampleInputs: StringArray,
  placeholderRoles: StringArray,
});

/** One effect journal row (`storage-graph-effects.ts` `GraphEffectRecord`). */
export interface GraphRunEffectShape {
  id: string;
  runId: string;
  key: string;
  action: string;
  nodeId: string;
  activation: string;
  state: "intended" | "done" | "failed" | "simulated";
  attempts: number;
  intendedAt: string;
  settledAt?: string;
  data?: Record<string, unknown>;
  error?: string;
}

/** `graph_run_effects`. */
export const GraphRunEffectsResultSchema = Schema.Struct({
  effects: mutableArray(
    modelRecord<GraphRunEffectShape>()({
      id: Schema.String,
      runId: Schema.String,
      key: Schema.String,
      action: Schema.String,
      nodeId: Schema.String,
      activation: Schema.String,
      state: Schema.String,
      attempts: Schema.Finite,
      intendedAt: Schema.String,
      settledAt: optionalString,
      data: Schema.optional(OpenObject),
      error: optionalString,
    }),
  ),
});

// --------------------------------------------------------------- runs

/** `graph_runs_list`: one row per run. */
export const GraphRunSummarySchema = modelRecord<GraphRunSummary>()({
  id: Schema.String,
  projectId: Schema.String,
  environmentId: optionalString,
  template: RunTemplateRefSchema,
  name: Schema.String,
  status: Schema.String,
  mock: Schema.Boolean,
  revision: Schema.Finite,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  startedAt: optionalString,
  finishedAt: optionalString,
  error: optionalString,
  usage: RunUsageSchema,
  activations: modelRecord<GraphRunSummary["activations"]>()({
    live: Schema.Finite,
    running: Schema.Finite,
    awaitingHuman: Schema.Finite,
    complete: Schema.Finite,
    failed: Schema.Finite,
  }),
});

/** `graph_run_get` and the run controls: the snapshot, or `unchanged`. */
export const GraphRunGetResultSchema = asModel<GraphRunGetResult>(
  Schema.Union([
    Schema.Struct({ status: Schema.Literal("changed"), run: GraphRunSchema }),
    Schema.Struct({ status: Schema.Literal("unchanged"), revision: Schema.Finite }),
  ]),
);

const ArtifactFileSchema = modelRecord<GraphArtifactFile>()({
  path: Schema.String,
  sha256: Schema.String,
  bytes: Schema.Finite,
});

/**
 * `graph_run_artifact`. The envelope is not refined by `validateGraphArtifact`:
 * the view sends it without its `body`, which that guard requires.
 */
export const GraphRunArtifactViewSchema = modelRecord<GraphRunArtifactView>()({
  artifact: modelRecord<Omit<GraphArtifact, "body">>()({
    formatVersion: Schema.Finite,
    id: Schema.String,
    digest: Schema.String,
    type: Schema.String,
    runId: Schema.String,
    producer: OpenObject,
    inputs: StringArray,
    createdAt: Schema.String,
  }),
  file: Schema.optional(ArtifactFileSchema),
  value: Schema.optional(Schema.Unknown),
  valueOmitted: optionalString,
});

/** `graph_run_transcript`: one window, or why there is none. */
export const GraphRunTranscriptViewSchema = asModel<GraphRunTranscriptView>(
  Schema.Union([
    Schema.Struct({
      status: Schema.Literal("found"),
      messages: Schema.Array(Schema.Unknown),
      startIndex: Schema.Finite,
      messageCount: Schema.Finite,
      revision: Schema.Finite,
      complete: Schema.Boolean,
      truncated: Schema.optional(Schema.Literal(true)),
    }),
    Schema.Struct({ status: Schema.Literal("none") }),
    Schema.Struct({ status: Schema.Literal("missing") }),
    Schema.Struct({ status: Schema.Literal("unavailable"), reason: Schema.String }),
  ]),
);

const PendingBase = {
  runId: Schema.String,
  activationKey: Schema.String,
  nodeId: Schema.String,
  title: Schema.String,
  openedAt: Schema.String,
} as const;

/** `graph_run_pending`: open human waits and `ask_human` questions. */
export const GraphRunPendingInteractionSchema = asModel<GraphRunPendingInteraction>(
  Schema.Union([
    modelRecord<GraphRunPendingHumanWait>()({
      ...PendingBase,
      kind: Schema.Literal("human"),
      waitId: Schema.String,
      form: Schema.String,
    }),
    modelRecord<GraphRunPendingQuestion>()({
      ...PendingBase,
      kind: Schema.Literal("question"),
      questionId: Schema.String,
      text: Schema.String,
    }),
  ]),
);

const AgentQuestionSchema = modelRecord<GraphAgentQuestion>()({
  id: Schema.String,
  text: Schema.String,
  askedAt: Schema.String,
});

const HumanWaitSchema = modelRecord<GraphHumanWait>()({
  id: Schema.String,
  form: Schema.String,
  openedAt: Schema.String,
});

/** `graph_run_answer`: the question form's answer, or the human node form's. */
export const GraphRunAnswerResultSchema = Schema.Union([
  Schema.Struct({ activationKey: Schema.String, question: Schema.NullOr(AgentQuestionSchema) }),
  Schema.Struct({ activationKey: Schema.String, human: Schema.NullOr(HumanWaitSchema) }),
]);

const RewindSchema = modelRecord<GraphRewind>()({
  id: Schema.String,
  kind: Schema.String,
  nodeId: Schema.String,
  activation: Schema.String,
  iteration: Schema.Finite,
  requestedAt: Schema.String,
});

/** `graph_run_restart` and `graph_run_rewind_code`. */
export const GraphRunRestartResultSchema = modelRecord<GraphRunRestartResult>()({
  run: GraphRunSchema,
  rewind: RewindSchema,
  repeated: Schema.Boolean,
});

/** `graph_run_rewind_code_preview`. */
export const GraphRunCodeRewindPreviewSchema = modelRecord<GraphRunCodeRewindPreview>()({
  runId: Schema.String,
  activationKey: Schema.String,
  nodeId: Schema.String,
  iteration: Schema.Finite,
  targetCommit: optionalString,
  head: optionalString,
  commits: Schema.Array(
    modelRecord<{ sha: string; subject: string }>()({ sha: Schema.String, subject: Schema.String }),
  ),
  commitCount: Schema.Finite,
  supersedes: OpenObject,
});
