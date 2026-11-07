import type {
  McpDefaultsRefreshPreview,
  McpDefaultsRefreshRequest,
  McpEditableDefinition,
  McpManagementSnapshot,
  McpMutation,
  McpMutationResult,
  McpOperationSnapshot,
  McpOverlayResolution,
  McpOverlayResolutionResult,
  McpTargetList,
  McpValidationResult,
} from "@orkestrator/protocol/mcp-management";

import { mcpOn } from "@/lib/node-scope/domains/mcp";
import { type AccountMachine } from "./agent-accounts";
import { commandBackendClient, type BackendClient } from "./client";

// `machine` names the node whose MCP configuration is read or written,
// through the command node; omitted, this view's own backend. Every call goes
// through the `mcp` domain client (plan item 7008, `lib/node-scope/domains/mcp.ts`).

/**
 * This file's commands on `client`'s node (plan item 3002). A scoped store or
 * service passes its own node's client; the named exports below are this
 * over the window's command scope.
 */
export function createMcpManagementApi(client: BackendClient) {
  const mcp = mcpOn(client);

  /** Backend and environment targets for MCP server management. */
  function listMcpManagementTargets(
    environmentId?: string,
    machine?: AccountMachine,
  ): Promise<McpTargetList> {
    return mcp(machine).list_mcp_management_targets(environmentId ? { environmentId } : {});
  }

  /** Passive catalog: reads files, never starts a server or touches a session. */
  function getMcpManagementSnapshot(
    targetId: string,
    machine?: AccountMachine,
  ): Promise<McpManagementSnapshot> {
    return mcp(machine).get_mcp_management_snapshot({ targetId });
  }

  /** Editable, redacted view of one saved definition. */
  function getMcpDefinition(
    targetId: string,
    entryId: string,
    machine?: AccountMachine,
  ): Promise<McpEditableDefinition> {
    return mcp(machine).get_mcp_definition({ targetId, entryId });
  }

  /** Field errors and an impact preview; writes nothing. */
  function validateMcpMutation(
    mutation: McpMutation,
    machine?: AccountMachine,
  ): Promise<McpValidationResult> {
    return mcp(machine).validate_mcp_mutation({ mutation });
  }

  /** Conflict-checked save; `save-and-apply` also schedules runtime application. */
  function mutateMcpDefinition(
    mutation: McpMutation,
    machine?: AccountMachine,
  ): Promise<McpMutationResult> {
    return mcp(machine).mutate_mcp_definition({ mutation });
  }

  /** Retry runtime application of an already saved change. Never re-saves. */
  function applyMcpConfiguration(
    operationId: string,
    machine?: AccountMachine,
  ): Promise<McpOperationSnapshot> {
    return mcp(machine).apply_mcp_configuration({ operationId });
  }

  function getMcpOperation(
    operationId: string,
    machine?: AccountMachine,
  ): Promise<McpOperationSnapshot> {
    return mcp(machine).get_mcp_operation({ operationId });
  }

  /** Cancel queued application; the saved configuration is kept. */
  function cancelMcpApply(
    operationId: string,
    machine?: AccountMachine,
  ): Promise<McpOperationSnapshot> {
    return mcp(machine).cancel_mcp_apply({ operationId });
  }

  /**
   * Import, reapply, resolve a conflict in, or reset a container environment's
   * own MCP changes. `expectedRevision` is the source revision the user saw.
   */
  function resolveMcpEnvironmentOverlay(
    resolution: McpOverlayResolution,
    machine?: AccountMachine,
  ): Promise<McpOverlayResolutionResult> {
    return mcp(machine).resolve_mcp_environment_overlay({ resolution });
  }

  /** What re-importing the backend user's servers into a container source would change. Names only. */
  function previewMcpEnvironmentDefaults(
    request: Omit<McpDefaultsRefreshRequest, "previewToken">,
    machine?: AccountMachine,
  ): Promise<McpDefaultsRefreshPreview> {
    return mcp(machine).preview_mcp_environment_defaults({ request });
  }

  /** Apply a previewed refresh; a stale `previewToken` fails with `revision-conflict`. */
  function refreshMcpEnvironmentDefaults(
    request: McpDefaultsRefreshRequest,
    machine?: AccountMachine,
  ): Promise<
    McpOverlayResolutionResult & { stagedCopy: "updated" | "unavailable" | "not-needed" }
  > {
    return mcp(machine).refresh_mcp_environment_defaults({ request });
  }

  return {
    listMcpManagementTargets,
    getMcpManagementSnapshot,
    getMcpDefinition,
    validateMcpMutation,
    mutateMcpDefinition,
    applyMcpConfiguration,
    getMcpOperation,
    cancelMcpApply,
    resolveMcpEnvironmentOverlay,
    previewMcpEnvironmentDefaults,
    refreshMcpEnvironmentDefaults,
  };
}

export type McpManagementApi = ReturnType<typeof createMcpManagementApi>;

/** The window's command-scope binding (the counted shim, plan item 3002). */
export const {
  listMcpManagementTargets,
  getMcpManagementSnapshot,
  getMcpDefinition,
  validateMcpMutation,
  mutateMcpDefinition,
  applyMcpConfiguration,
  getMcpOperation,
  cancelMcpApply,
  resolveMcpEnvironmentOverlay,
  previewMcpEnvironmentDefaults,
  refreshMcpEnvironmentDefaults,
} = createMcpManagementApi(commandBackendClient);
