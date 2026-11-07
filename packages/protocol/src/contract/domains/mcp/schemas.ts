/**
 * Result schemas of the `mcp` commands (plan item 7008), over the protocol's
 * own model types (`@orkestrator/protocol/mcp-management`).
 *
 * Each record is a {@link modelRecord}: the fields that identify it and that
 * callers branch on (ids, revisions, states, kinds, `protocolVersion`) are
 * validated, and every other key passes through a client's tolerant decode,
 * so a newer backend's fields reach the renderer. Enumerations a newer
 * backend may extend (apply states, phases, scopes, statuses, transports) are
 * `Schema.String`; the renderer's own guards decide what it understands.
 * Optional fields are `Schema.optional`, which also accepts the explicit
 * `undefined` the service spreads (`readOnlyReason: undefined`).
 *
 * Snapshots and target lists keep `protocolVersion` (Appendix F): the
 * renderer still reads it to refuse a management protocol it does not speak.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import type {
  McpConfigSource,
  McpDefaultsRefreshPreview,
  McpDefinitionSummary,
  McpEditableDefinition,
  McpEnvironmentOverlayState,
  McpImpactPreview,
  McpManagementRolloutSettings,
  McpManagementSnapshot,
  McpManagementTarget,
  McpMutationResult,
  McpOperationSnapshot,
  McpOverlayResolutionResult,
  McpRuntimeApplyEntry,
  McpTargetCapabilities,
  McpTargetContext,
  McpTargetList,
  McpValidationResult,
} from "../../../mcp-management.js";
import { modelRecord } from "../../model-schema.js";

const NullableString = Schema.NullOr(Schema.String);
const Strings = Schema.Array(Schema.String);

export const McpTargetContextSchema = modelRecord<McpTargetContext>()({
  kind: Schema.String,
  location: Schema.String,
  locationLabel: Schema.String,
  environmentId: Schema.optional(Schema.String),
  projectId: Schema.optional(Schema.String),
});

export const McpTargetCapabilitiesSchema = modelRecord<McpTargetCapabilities>()({
  management: Schema.Struct({
    supported: Schema.Boolean,
    reason: Schema.optional(Schema.String),
  }),
  apply: Schema.Struct({
    strategy: Schema.String,
    impact: Schema.String,
    description: Schema.String,
  }),
});

export const McpManagementTargetSchema = modelRecord<McpManagementTarget>()({
  targetId: Schema.String,
  backendId: Schema.String,
  provider: Schema.String,
  providerLabel: Schema.String,
  context: McpTargetContextSchema,
  defaultSourceId: NullableString,
  capabilities: McpTargetCapabilitiesSchema,
  readOnlyReason: Schema.optional(Schema.String),
}).annotate({ identifier: "McpManagementTarget" });

/** `list_mcp_management_targets`. */
export const McpTargetListSchema = modelRecord<McpTargetList>()({
  protocolVersion: Schema.Finite,
  backendId: Schema.String,
  targets: Schema.Array(McpManagementTargetSchema),
}).annotate({ identifier: "McpTargetList" });

export const McpEnvironmentOverlayStateSchema = modelRecord<McpEnvironmentOverlayState>()({
  revision: Schema.Finite,
  state: Schema.String,
  added: Strings,
  replaced: Strings,
  removed: Strings,
  divergedNames: Strings,
}).annotate({ identifier: "McpEnvironmentOverlayState" });

export const McpConfigSourceSchema = modelRecord<McpConfigSource>()({
  sourceId: Schema.String,
  scope: Schema.String,
  owner: Schema.String,
  format: Schema.String,
  label: Schema.String,
  precedence: Schema.Finite,
  state: Schema.String,
  writable: Schema.Boolean,
  revision: NullableString,
  sharedWith: Strings,
  overlay: Schema.optional(McpEnvironmentOverlayStateSchema),
});

export const McpDefinitionSummarySchema = modelRecord<McpDefinitionSummary>()({
  entryId: Schema.String,
  sourceId: Schema.String,
  name: Schema.String,
  transport: Schema.String,
  enabled: Schema.NullOr(Schema.Boolean),
  status: Schema.String,
  shadows: Strings,
  preservedFields: Strings,
  secretCount: Schema.Finite,
});

export const McpRuntimeApplyEntrySchema = modelRecord<McpRuntimeApplyEntry>()({
  runtimeId: Schema.String,
  environmentId: NullableString,
  state: Schema.String,
  updatedAt: Schema.String,
});

/** An operation's save phase and its runtime application. */
export const McpOperationSnapshotSchema = modelRecord<McpOperationSnapshot>()({
  operationId: Schema.String,
  requestId: Schema.String,
  targetId: Schema.String,
  provider: Schema.String,
  kind: Schema.String,
  sourceId: Schema.String,
  phase: Schema.String,
  savedRevision: Schema.optional(Schema.String),
  resultEntryId: Schema.optional(Schema.String),
  errorCode: Schema.optional(Schema.String),
  applyIntent: Schema.String,
  apply: Schema.StructWithRest(
    Schema.Struct({
      state: Schema.String,
      runtimes: Schema.Array(McpRuntimeApplyEntrySchema),
      omitted: Schema.Finite,
    }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  createdAt: Schema.String,
  updatedAt: Schema.String,
}).annotate({ identifier: "McpOperationSnapshot" });

/** `get_mcp_management_snapshot`: the passive catalog of one target. */
export const McpManagementSnapshotSchema = modelRecord<McpManagementSnapshot>()({
  protocolVersion: Schema.Finite,
  target: McpManagementTargetSchema,
  sources: Schema.Array(McpConfigSourceSchema),
  definitions: Schema.Array(McpDefinitionSummarySchema),
  effective: Schema.Record(Schema.String, Schema.String),
  operations: Schema.Array(McpOperationSnapshotSchema),
  catalogRevision: Schema.Finite,
  freshness: Schema.String,
  truncated: Schema.Finite,
  generatedAt: Schema.String,
}).annotate({ identifier: "McpManagementSnapshot" });

/** `get_mcp_definition`: the editable, redacted view of one saved definition. */
export const McpEditableDefinitionSchema = modelRecord<McpEditableDefinition>()({
  entryId: Schema.String,
  sourceId: Schema.String,
  sourceRevision: Schema.String,
  name: Schema.String,
  transport: Schema.String,
  enabled: Schema.NullOr(Schema.Boolean),
  preservedFields: Strings,
}).annotate({ identifier: "McpEditableDefinition" });

export const McpImpactPreviewSchema = modelRecord<McpImpactPreview>()({
  sourceId: Schema.String,
  sourceLabel: Schema.String,
  changedFields: Strings,
  sharedWith: Strings,
  warnings: Strings,
});

/** `validate_mcp_mutation`: field errors and an impact preview; nothing written. */
export const McpValidationResultSchema = modelRecord<McpValidationResult>()({
  valid: Schema.Boolean,
  fieldErrors: Schema.Array(Schema.Struct({ field: Schema.String, message: Schema.String })),
  preview: Schema.NullOr(McpImpactPreviewSchema),
}).annotate({ identifier: "McpValidationResult" });

/** `mutate_mcp_definition`. */
export const McpMutationResultSchema = modelRecord<McpMutationResult>()({
  operation: McpOperationSnapshotSchema,
  replayed: Schema.Boolean,
  savedRevision: Schema.String,
  entryId: NullableString,
}).annotate({ identifier: "McpMutationResult" });

/** `resolve_mcp_environment_overlay`. */
export const McpOverlayResolutionResultSchema = modelRecord<McpOverlayResolutionResult>()({
  sourceRevision: NullableString,
  overlay: Schema.NullOr(McpEnvironmentOverlayStateSchema),
}).annotate({ identifier: "McpOverlayResolutionResult" });

/** `preview_mcp_environment_defaults`: names only, never values. */
export const McpDefaultsRefreshPreviewSchema = modelRecord<McpDefaultsRefreshPreview>()({
  targetId: Schema.String,
  sourceId: Schema.String,
  sourceLabel: Schema.String,
  previewToken: Schema.String,
  added: Strings,
  changed: Strings,
  removed: Strings,
  conflicts: Schema.Array(Schema.Struct({ name: Schema.String, reason: Schema.String })),
  diverged: Strings,
  unchanged: Schema.Boolean,
  warnings: Strings,
}).annotate({ identifier: "McpDefaultsRefreshPreview" });

/** `refresh_mcp_environment_defaults`: the resolution, and what happened to the staged copy. */
export type McpDefaultsRefreshResult = McpOverlayResolutionResult & {
  stagedCopy: "updated" | "unavailable" | "not-needed";
};

export const McpDefaultsRefreshResultSchema = modelRecord<McpDefaultsRefreshResult>()({
  sourceRevision: NullableString,
  overlay: Schema.NullOr(McpEnvironmentOverlayStateSchema),
  stagedCopy: Schema.String,
}).annotate({ identifier: "McpDefaultsRefreshResult" });

/** The backend-owned rollout gate (`global.mcpManagement`, normalised). */
export const McpManagementRolloutSettingsSchema = modelRecord<McpManagementRolloutSettings>()({
  enabled: Schema.Boolean,
  writeProviders: Strings,
  applyProviders: Strings,
}).annotate({ identifier: "McpManagementRolloutSettings" });
