/**
 * `graphs` commands that start work: "Describe a graph" jobs (item 215),
 * launches from the app (item 214), mock runs and the effect journal (item
 * 213). Registered by the backend's `commands-registry-graph-describe.ts`,
 * `-graph-launch.ts` and `-graph-mock.ts`. The argument rules are those of
 * `commands-templates.ts`: the handlers keep their validators
 * (`parseGraphDescribeStartInput`, `parseGraphLaunchRequest`, the mock
 * checks), which throw a coded `GraphDescribeError`, `GraphLaunchError` or
 * `GraphRunServiceError`.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { defineCommand } from "../../command.js";
import { graphsDomain } from "./domain.js";
import {
  GraphDescribeDismissResultSchema,
  GraphDescribeJobViewSchema,
  GraphLaunchOptionsSchema,
  GraphLaunchResultSchema,
  GraphMockLaunchResultSchema,
  GraphRunEffectsResultSchema,
  NullableGraphDescribeJobViewSchema,
} from "./schemas.js";

const checked = Schema.optionalKey(Schema.Unknown);
const environmentArgs = Schema.Struct({ environmentId: checked });

export const graphDescribeStartCommand = defineCommand({
  domain: graphsDomain,
  name: "graph_describe_start",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: checked,
    description: checked,
    agent: checked,
    model: checked,
    reasoningEffort: checked,
    fastMode: checked,
    baseDraft: checked,
  }),
  result: GraphDescribeJobViewSchema,
  critical: [],
});

export const graphDescribeStatusCommand = defineCommand({
  domain: graphsDomain,
  name: "graph_describe_status",
  since: 1,
  access: "workspace",
  read: true,
  args: environmentArgs,
  result: NullableGraphDescribeJobViewSchema,
  critical: [],
});

export const graphDescribeCancelCommand = defineCommand({
  domain: graphsDomain,
  name: "graph_describe_cancel",
  since: 1,
  access: "workspace",
  read: false,
  args: environmentArgs,
  result: NullableGraphDescribeJobViewSchema,
  critical: [],
});

export const graphDescribeDismissCommand = defineCommand({
  domain: graphsDomain,
  name: "graph_describe_dismiss",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ environmentId: checked, jobId: checked }),
  result: GraphDescribeDismissResultSchema,
  critical: [],
});

/** What the launch dialog shows: compiles for launch and reads saved defaults, writes nothing. */
export const graphLaunchOptionsCommand = defineCommand({
  domain: graphsDomain,
  name: "graph_launch_options",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    ref: checked,
    projectId: checked,
    environmentId: checked,
    create: checked,
  }),
  result: GraphLaunchOptionsSchema,
  critical: [],
});

/**
 * `requestId` is the launch's idempotency key: ignored, a retry would launch a
 * second run. `template` (a draft) and `requestedBy` (a caller-chosen origin)
 * are not launch fields: they are declared so that `parseGraphLaunchRequest`
 * still sees and refuses them, rather than the launch silently running the
 * stored template as the user.
 */
export const graphRunLaunchCommand = defineCommand({
  domain: graphsDomain,
  name: "graph_run_launch",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    ref: checked,
    projectId: checked,
    environment: checked,
    roles: checked,
    params: checked,
    inputs: checked,
    ticket: checked,
    saveDefaults: checked,
    requestId: checked,
    template: checked,
    requestedBy: checked,
  }),
  result: GraphLaunchResultSchema,
  critical: ["requestId"],
});

export const graphRunMockCommand = defineCommand({
  domain: graphsDomain,
  name: "graph_run_mock",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    ref: checked,
    projectId: checked,
    environmentId: checked,
    inputs: checked,
    params: checked,
    roles: checked,
    pins: checked,
    panel: checked,
    stepMs: checked,
  }),
  result: GraphMockLaunchResultSchema,
  critical: [],
});

export const graphRunEffectsCommand = defineCommand({
  domain: graphsDomain,
  name: "graph_run_effects",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ runId: checked }),
  result: GraphRunEffectsResultSchema,
  critical: [],
});

export const GRAPH_LAUNCH_COMMANDS = [
  graphDescribeStartCommand,
  graphDescribeStatusCommand,
  graphDescribeCancelCommand,
  graphDescribeDismissCommand,
  graphLaunchOptionsCommand,
  graphRunLaunchCommand,
  graphRunMockCommand,
  graphRunEffectsCommand,
] as const;
