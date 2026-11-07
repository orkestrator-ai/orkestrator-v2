/**
 * `mcp` commands (plan item 7008): MCP configuration management on one
 * backend (targets, the passive catalog, editable definitions, validated
 * mutations and their runtime application, container overlays and defaults
 * refresh) and the backend-owned rollout gate.
 *
 * Every handler hands its arguments to `McpManagementService`, which checks
 * each one itself and answers a structured `McpManagementError`
 * (`invalid-request`, `unknown-target`, ...) with its own message. So every
 * argument key is `optionalKey(Unknown)`: a decode never refuses what the
 * service accepts today, and every error keeps its code, message and
 * correlation id. The arguments are declared so that the tolerant decode
 * keeps them; anything else is dropped (§11.4).
 *
 * No key is critical: the nested `mutation`, `resolution` and `request`
 * records carry their own compare-and-swap revisions and request ids, which
 * every version of the service reads, and no command has an optional
 * must-understand key an older backend could ignore.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { defineCommand } from "../../command.js";
import { mcpDomain } from "./domain.js";
import {
  McpDefaultsRefreshPreviewSchema,
  McpDefaultsRefreshResultSchema,
  McpEditableDefinitionSchema,
  McpManagementRolloutSettingsSchema,
  McpManagementSnapshotSchema,
  McpMutationResultSchema,
  McpOperationSnapshotSchema,
  McpOverlayResolutionResultSchema,
  McpTargetListSchema,
  McpValidationResultSchema,
} from "./schemas.js";

const optionalUnknown = Schema.optionalKey(Schema.Unknown);

/** The backend's target and every environment's (or one environment's). */
export const listMcpManagementTargetsCommand = defineCommand({
  domain: mcpDomain,
  name: "list_mcp_management_targets",
  since: 1,
  access: "workspace",
  read: true,
  critical: [],
  args: Schema.Struct({ environmentId: optionalUnknown }),
  result: McpTargetListSchema,
});

/** The passive catalog: reads files, never starts a server or touches a session. */
export const getMcpManagementSnapshotCommand = defineCommand({
  domain: mcpDomain,
  name: "get_mcp_management_snapshot",
  since: 1,
  access: "workspace",
  read: true,
  critical: [],
  args: Schema.Struct({ targetId: optionalUnknown }),
  result: McpManagementSnapshotSchema,
});

/** The editable, redacted view of one saved definition. */
export const getMcpDefinitionCommand = defineCommand({
  domain: mcpDomain,
  name: "get_mcp_definition",
  since: 1,
  access: "workspace",
  read: true,
  critical: [],
  args: Schema.Struct({ targetId: optionalUnknown, entryId: optionalUnknown }),
  result: McpEditableDefinitionSchema,
});

/** Field errors and an impact preview; writes nothing. */
export const validateMcpMutationCommand = defineCommand({
  domain: mcpDomain,
  name: "validate_mcp_mutation",
  since: 1,
  access: "workspace",
  read: false,
  critical: [],
  args: Schema.Struct({ mutation: optionalUnknown }),
  result: McpValidationResultSchema,
});

/** A conflict-checked save; `save-and-apply` also schedules runtime application. */
export const mutateMcpDefinitionCommand = defineCommand({
  domain: mcpDomain,
  name: "mutate_mcp_definition",
  since: 1,
  access: "workspace",
  read: false,
  critical: [],
  args: Schema.Struct({ mutation: optionalUnknown }),
  result: McpMutationResultSchema,
});

/** Retry the runtime application of an already saved change. Never re-saves. */
export const applyMcpConfigurationCommand = defineCommand({
  domain: mcpDomain,
  name: "apply_mcp_configuration",
  since: 1,
  access: "workspace",
  read: false,
  critical: [],
  args: Schema.Struct({ operationId: optionalUnknown }),
  result: McpOperationSnapshotSchema,
});

export const getMcpOperationCommand = defineCommand({
  domain: mcpDomain,
  name: "get_mcp_operation",
  since: 1,
  access: "workspace",
  read: true,
  critical: [],
  args: Schema.Struct({ operationId: optionalUnknown }),
  result: McpOperationSnapshotSchema,
});

/** Cancel queued application; the saved configuration is kept. */
export const cancelMcpApplyCommand = defineCommand({
  domain: mcpDomain,
  name: "cancel_mcp_apply",
  since: 1,
  access: "workspace",
  read: false,
  critical: [],
  args: Schema.Struct({ operationId: optionalUnknown }),
  result: McpOperationSnapshotSchema,
});

/** Import, reapply, resolve a conflict in, or reset a container's own MCP changes. */
export const resolveMcpEnvironmentOverlayCommand = defineCommand({
  domain: mcpDomain,
  name: "resolve_mcp_environment_overlay",
  since: 1,
  access: "workspace",
  read: false,
  critical: [],
  args: Schema.Struct({ resolution: optionalUnknown }),
  result: McpOverlayResolutionResultSchema,
});

/** What re-importing the backend user's servers into a container source would change. */
export const previewMcpEnvironmentDefaultsCommand = defineCommand({
  domain: mcpDomain,
  name: "preview_mcp_environment_defaults",
  since: 1,
  access: "workspace",
  read: false,
  critical: [],
  args: Schema.Struct({ request: optionalUnknown }),
  result: McpDefaultsRefreshPreviewSchema,
});

/** Apply a previewed refresh; a stale `previewToken` fails with `revision-conflict`. */
export const refreshMcpEnvironmentDefaultsCommand = defineCommand({
  domain: mcpDomain,
  name: "refresh_mcp_environment_defaults",
  since: 1,
  access: "workspace",
  read: false,
  critical: [],
  args: Schema.Struct({ request: optionalUnknown }),
  result: McpDefaultsRefreshResultSchema,
});

/**
 * The backend-owned rollout gate / kill switch. An operator surface no
 * window calls (`admin`): it changes what every client of the machine may
 * save or apply.
 */
export const getMcpManagementRolloutCommand = defineCommand({
  domain: mcpDomain,
  name: "get_mcp_management_rollout",
  since: 1,
  access: "admin",
  read: true,
  critical: [],
  args: Schema.Struct({}),
  result: McpManagementRolloutSettingsSchema,
});

export const setMcpManagementRolloutCommand = defineCommand({
  domain: mcpDomain,
  name: "set_mcp_management_rollout",
  since: 1,
  access: "admin",
  read: false,
  critical: [],
  args: Schema.Struct({
    enabled: optionalUnknown,
    writeProviders: optionalUnknown,
    applyProviders: optionalUnknown,
  }),
  result: McpManagementRolloutSettingsSchema,
});

/** Every `mcp` command, in registration order. */
export const MCP_COMMANDS = [
  listMcpManagementTargetsCommand,
  getMcpManagementSnapshotCommand,
  getMcpDefinitionCommand,
  validateMcpMutationCommand,
  mutateMcpDefinitionCommand,
  applyMcpConfigurationCommand,
  getMcpOperationCommand,
  cancelMcpApplyCommand,
  resolveMcpEnvironmentOverlayCommand,
  previewMcpEnvironmentDefaultsCommand,
  refreshMcpEnvironmentDefaultsCommand,
  getMcpManagementRolloutCommand,
  setMcpManagementRolloutCommand,
] as const;
