/**
 * Result schemas of the `nodes` commands (plan item 7009).
 *
 * Model records whose type is in the protocol (`NodeView`, `NodeStatus`,
 * `NodeSummariesResult`, `PortalLayout`, `BackendProfile`, `ProjectCopyRecord`,
 * ...) are `modelRecord<T>()`: the fields a reader routes on are checked and
 * every other key passes through, typed as the protocol's own interface. The
 * backend's own records (`NodeSshPromptView`, `OpenedNodeWorkspace`,
 * `ClientGrant`, `FileComparison`, ...) are open structs ({@link openStruct}):
 * the same rule, typed by their fields. A decode on the client is tolerant,
 * so a closed struct would strip the fields a newer backend adds.
 *
 * Values a newer backend may extend (modes, states, outcomes) are
 * `Schema.String`.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import type { BackendProfile } from "../../../backend-profile.js";
import type {
  AttachControllerResult,
  CommandHandoverPreview,
  CommandHandoverResult,
  ControllerView,
  NodeListResult,
  NodeStatus,
  NodeView,
} from "../../../command-nodes.js";
import type { NodeEventWatchResult } from "../../../node-events.js";
import type { NodeSummariesResult } from "../../../node-summaries.js";
import type { PortalLayout } from "../../../portal-layout.js";
import type { ProjectCopyOptions, ProjectCopyRecord } from "../../../project-copy.js";
import { modelRecord } from "../../model-schema.js";

/**
 * A record whose listed fields are checked and typed, every other key kept
 * (`Schema.StructWithRest` with a string-keyed rest of unknown values).
 */
export function openStruct<const Fields extends Schema.Struct.Fields>(
  fields: Fields,
): Schema.Codec<Schema.Struct<Fields>["Type"], Schema.Struct<Fields>["Encoded"]> {
  return Schema.StructWithRest(Schema.Struct(fields), [
    Schema.Record(Schema.String, Schema.Unknown),
  ]) as unknown as Schema.Codec<Schema.Struct<Fields>["Type"], Schema.Struct<Fields>["Encoded"]>;
}

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const StringArray = Schema.Array(Schema.String);
const AnyObject = openStruct({});

export const ControllerViewSchema = modelRecord<ControllerView>()({
  controllerId: Schema.String,
  displayName: Schema.String,
});

/**
 * Readers route on `nodeId` and `mode`; the rest is optional here because the
 * coordinator's in-process reads are faked with `{ nodeId, mode }` in tests
 * (the service always writes every field).
 */
export const NodeStatusSchema = modelRecord<NodeStatus>()({
  nodeId: Schema.String,
  mode: Schema.String,
  registrationEnabled: Schema.optional(Schema.Boolean),
  controllers: Schema.optional(Schema.Array(ControllerViewSchema)),
});

export const NodeViewSchema = modelRecord<NodeView>()({
  nodeId: Schema.String,
  enabled: Schema.Boolean,
  displayName: Schema.String,
  hasCredential: Schema.Boolean,
  routes: Schema.Array(AnyObject),
  connection: AnyObject,
});

export const NodeListResultSchema = modelRecord<NodeListResult>()({
  revision: Schema.Finite,
  mode: Schema.String,
  nodes: Schema.Array(NodeViewSchema),
});

export const AttachControllerResultSchema = modelRecord<AttachControllerResult>()({
  nodeId: Schema.String,
  mode: Schema.String,
});

export const CommandHandoverPreviewSchema = modelRecord<CommandHandoverPreview>()({
  targetNodeId: Schema.String,
  targetRegistered: Schema.Boolean,
  targetNodeIds: StringArray,
  candidates: Schema.Array(AnyObject),
  self: AnyObject,
});

export const CommandHandoverResultSchema = modelRecord<CommandHandoverResult>()({
  targetNodeId: Schema.String,
  transferred: Schema.Finite,
  skipped: Schema.Finite,
  needsCredential: Schema.Finite,
  selfIncluded: Schema.Boolean,
});

/** What a leaf took on when an attached command node handed command over. */
export const AcceptCommandHandoverResultSchema = openStruct({
  imported: Schema.Finite,
  skipped: Schema.Finite,
  needsCredential: Schema.Finite,
  detachedControllers: Schema.Finite,
});

export const ImportDesktopConnectionsResultSchema = openStruct({
  imported: Schema.Finite,
  skipped: Schema.Finite,
  needsCredential: Schema.Finite,
});

export const NodeSshPromptViewSchema = openStruct({
  promptId: Schema.String,
  nodeId: Schema.String,
  kind: Schema.String,
  message: Schema.String,
  state: Schema.String,
});

export const HostKeyProbeSchema = openStruct({
  probeId: Schema.String,
  destination: Schema.String,
  fingerprints: Schema.Array(openStruct({ type: Schema.String, fingerprint: Schema.String })),
});

export const NodeSummariesResultSchema = modelRecord<NodeSummariesResult>()({
  selfId: Schema.String,
  nodes: Schema.Array(AnyObject),
});

/**
 * `invoke_on_node`'s answer: the routed command's own result, or the
 * outcome-unknown record of a write whose answer was lost.
 */
export const RoutedResultSchema = Schema.Union([
  openStruct({ outcome: Schema.Literal("ok"), result: Schema.Unknown }),
  openStruct({
    outcome: Schema.Literal("unknown"),
    requestKey: Schema.String,
    outcomeId: Schema.String,
  }),
]);

export const NodeEventWatchResultSchema = modelRecord<NodeEventWatchResult>()({
  watchId: Schema.String,
  expiresAt: Schema.Finite,
  renewed: Schema.Boolean,
});

export const NodeOutcomeRecordSchema = openStruct({
  outcomeId: Schema.String,
  nodeId: Schema.String,
  command: Schema.String,
  requestKey: Schema.String,
  recordedAt: Schema.String,
});

/** A leaf workspace opened for a client, with its short-lived grant. */
export const OpenedNodeWorkspaceSchema = openStruct({
  workspaceId: Schema.String,
  nodeId: Schema.String,
  nodeName: Schema.String,
  grant: openStruct({ token: Schema.String, expiresAt: Schema.Finite }),
  directOrigins: StringArray,
  relayBase: Schema.String,
  commandRouteKind: Schema.optional(Schema.String),
});

export const ClientGrantSchema = openStruct({
  grantId: Schema.String,
  controllerId: Schema.String,
  label: Schema.String,
  expiresAt: Schema.Finite,
});

export const CreatedClientGrantSchema = openStruct({
  grant: ClientGrantSchema,
  token: Schema.String,
});

export const PortalLayoutSchema = modelRecord<PortalLayout>()({
  revision: Schema.Finite,
  machineOrder: StringArray,
  projectOrder: StringArray,
});

export const BackendProfileSchema = modelRecord<BackendProfile>()({
  revision: Schema.Finite,
  displayName: Schema.String,
  colorToken: Schema.String,
});

/** An action request as the command node keeps it (the fields every kind has). */
export const NodeActionRequestRecordSchema = openStruct({
  requestId: Schema.String,
  kind: Schema.String,
  state: Schema.String,
});

/** An unattended account switch: run, already run, or why not. */
export const AccountSwitchOutcomeSchema = openStruct({
  outcome: Schema.String,
  request: Schema.optional(NodeActionRequestRecordSchema),
  recent: Schema.optional(Schema.Finite),
  limit: Schema.optional(Schema.Finite),
  windowMinutes: Schema.optional(Schema.Finite),
});

/** The section an AGENTS.md request's review diffs against, read on the node owning the copy. */
export const AgentsMdPreviewSchema = openStruct({
  baseBranch: Schema.optional(Schema.String),
  baseCommit: Schema.optional(Schema.String),
  fetched: Schema.optional(Schema.Boolean),
  fileExists: Schema.optional(Schema.Boolean),
  section: Schema.optional(Schema.Unknown),
  nodeName: Schema.optional(Schema.String),
});

/** A worker environment's details on its own node: the parts asked for in `include`. */
export const EnvironmentDetailsSchema = openStruct({
  environmentId: Schema.String,
  diff: Schema.optional(AnyObject),
  file: Schema.optional(AnyObject),
  tests: Schema.optional(Schema.Array(AnyObject)),
});

export const SeedFilesSchema = Schema.Array(
  openStruct({ path: Schema.String, exists: Schema.Boolean }),
);

/** Keyed fingerprints of a project's files on one node (never their contents). */
export const ProjectFileFingerprintsSchema = Schema.Array(
  openStruct({
    path: Schema.String,
    exists: Schema.Boolean,
    file: Schema.optional(Schema.String),
    envKeys: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
);

export const EnvValuesSchema = Schema.Record(Schema.String, Schema.String);

export const AppliedEnvKeysSchema = openStruct({
  set: NonNegativeInt,
  removed: NonNegativeInt,
});

export const FileComparisonSchema = openStruct({
  nodeId: Schema.String,
  nodeName: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  available: Schema.Boolean,
  files: Schema.Array(openStruct({ path: Schema.String, status: Schema.String })),
  error: Schema.optional(Schema.String),
});

export const ProjectFileComparisonSchema = openStruct({
  files: StringArray,
  nodes: Schema.Array(FileComparisonSchema),
});

export const SetupApprovalResultSchema = openStruct({
  nodes: Schema.Array(
    openStruct({
      nodeId: Schema.String,
      nodeName: Schema.String,
      status: Schema.String,
      projectIds: StringArray,
      error: Schema.optional(Schema.String),
    }),
  ),
});

export const ProjectCopyOptionsSchema = modelRecord<ProjectCopyOptions>()({
  source: AnyObject,
  targets: Schema.Array(AnyObject),
  candidates: Schema.Array(AnyObject),
  candidatesTruncated: Schema.Boolean,
});

export const ProjectCopyRecordSchema = modelRecord<ProjectCopyRecord>()({
  copyId: Schema.String,
  requestKey: Schema.String,
  stage: Schema.String,
  source: AnyObject,
  target: AnyObject,
});

/** `{ <flag>: boolean }` answers (`detached`, `allowed`, `discarded`, ...). */
export function flagResult<const Key extends string>(key: Key) {
  return openStruct({ [key]: Schema.Boolean } as { [K in Key]: typeof Schema.Boolean });
}
