/**
 * `graphs` commands of a run: the run view's reads and controls (item 211),
 * answers to waiting activations (items 204 and 208), and restart and code
 * rewind (item 210). Registered by the backend's
 * `commands-registry-graph-runs.ts`. The argument rules are those of
 * `commands-templates.ts`: the handlers keep their validators, which throw a
 * coded `GraphRunServiceError`, `GraphAgentQuestionError` or
 * `GraphRunRewindError`.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { mutableArray } from "../../model-schema.js";
import { defineCommand } from "../../command.js";
import { graphsDomain } from "./domain.js";
import {
  GraphRunAnswerResultSchema,
  GraphRunArtifactViewSchema,
  GraphRunCodeRewindPreviewSchema,
  GraphRunGetResultSchema,
  GraphRunPendingInteractionSchema,
  GraphRunRestartResultSchema,
  GraphRunSummarySchema,
  GraphRunTranscriptViewSchema,
} from "./schemas.js";

const checked = Schema.optionalKey(Schema.Unknown);

const runArgs = Schema.Struct({ runId: checked });
const activationArgs = Schema.Struct({ runId: checked, activationKey: checked });

export const graphRunsListCommand = defineCommand({
  domain: graphsDomain,
  name: "graph_runs_list",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ environmentId: checked }),
  result: mutableArray(GraphRunSummarySchema),
  critical: [],
});

export const graphRunGetCommand = defineCommand({
  domain: graphsDomain,
  name: "graph_run_get",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ runId: checked, knownRevision: checked }),
  result: GraphRunGetResultSchema,
  critical: [],
});

export const graphRunCancelCommand = defineCommand({
  domain: graphsDomain,
  name: "graph_run_cancel",
  since: 1,
  access: "workspace",
  read: false,
  args: runArgs,
  result: GraphRunGetResultSchema,
  critical: [],
});

export const graphRunPauseCommand = defineCommand({
  domain: graphsDomain,
  name: "graph_run_pause",
  since: 1,
  access: "workspace",
  read: false,
  args: runArgs,
  result: GraphRunGetResultSchema,
  critical: [],
});

export const graphRunResumeCommand = defineCommand({
  domain: graphsDomain,
  name: "graph_run_resume",
  since: 1,
  access: "workspace",
  read: false,
  args: runArgs,
  result: GraphRunGetResultSchema,
  critical: [],
});

export const graphRunRetryCommand = defineCommand({
  domain: graphsDomain,
  name: "graph_run_retry",
  since: 1,
  access: "workspace",
  read: false,
  args: activationArgs,
  result: GraphRunGetResultSchema,
  critical: [],
});

export const graphRunSkipCommand = defineCommand({
  domain: graphsDomain,
  name: "graph_run_skip",
  since: 1,
  access: "workspace",
  read: false,
  args: activationArgs,
  result: GraphRunGetResultSchema,
  critical: [],
});

export const graphRunArtifactCommand = defineCommand({
  domain: graphsDomain,
  name: "graph_run_artifact",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ runId: checked, artifactId: checked }),
  result: GraphRunArtifactViewSchema,
  critical: [],
});

export const graphRunTranscriptCommand = defineCommand({
  domain: graphsDomain,
  name: "graph_run_transcript",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    runId: checked,
    activationKey: checked,
    fromIndex: checked,
    maxBytes: checked,
  }),
  result: GraphRunTranscriptViewSchema,
  critical: [],
});

export const graphRunPendingCommand = defineCommand({
  domain: graphsDomain,
  name: "graph_run_pending",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ runId: checked, environmentId: checked }),
  result: mutableArray(GraphRunPendingInteractionSchema),
  critical: [],
});

/**
 * Both answer forms: an agent's question (`questionId`, `kind`, `text?`,
 * `choice?`) or, with `waitId`, a human node (`decision`, `outlet?`,
 * `value?`, `note?`). `value` is an `edit` form's edited input: a receiver
 * that ignored it would approve the unedited value.
 */
export const graphRunAnswerCommand = defineCommand({
  domain: graphsDomain,
  name: "graph_run_answer",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    runId: checked,
    activationKey: checked,
    questionId: checked,
    kind: checked,
    text: checked,
    choice: checked,
    waitId: checked,
    decision: checked,
    outlet: checked,
    value: checked,
    note: checked,
  }),
  result: GraphRunAnswerResultSchema,
  critical: ["value"],
});

export const graphRunRestartCommand = defineCommand({
  domain: graphsDomain,
  name: "graph_run_restart",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ runId: checked, activationKey: checked, requestId: checked }),
  result: GraphRunRestartResultSchema,
  critical: ["requestId"],
});

export const graphRunRewindCodePreviewCommand = defineCommand({
  domain: graphsDomain,
  name: "graph_run_rewind_code_preview",
  since: 1,
  access: "workspace",
  read: true,
  args: activationArgs,
  result: GraphRunCodeRewindPreviewSchema,
  critical: [],
});

export const graphRunRewindCodeCommand = defineCommand({
  domain: graphsDomain,
  name: "graph_run_rewind_code",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    runId: checked,
    activationKey: checked,
    expectedHead: checked,
    requestId: checked,
  }),
  result: GraphRunRestartResultSchema,
  critical: ["requestId"],
});

export const GRAPH_RUN_COMMANDS = [
  graphRunsListCommand,
  graphRunGetCommand,
  graphRunCancelCommand,
  graphRunPauseCommand,
  graphRunResumeCommand,
  graphRunRetryCommand,
  graphRunSkipCommand,
  graphRunArtifactCommand,
  graphRunTranscriptCommand,
  graphRunPendingCommand,
  graphRunAnswerCommand,
  graphRunRestartCommand,
  graphRunRewindCodePreviewCommand,
  graphRunRewindCodeCommand,
] as const;
