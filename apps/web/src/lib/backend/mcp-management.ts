import type {
  McpEditableDefinition,
  McpManagementSnapshot,
  McpMutation,
  McpMutationResult,
  McpOperationSnapshot,
  McpTargetList,
  McpValidationResult,
} from "@orkestrator/protocol/mcp-management";

import { invoke } from "@/lib/native/backend";

/** Backend and environment targets for MCP server management. */
export function listMcpManagementTargets(environmentId?: string): Promise<McpTargetList> {
  return invoke("list_mcp_management_targets", environmentId ? { environmentId } : {});
}

/** Passive catalog: reads files, never starts a server or touches a session. */
export function getMcpManagementSnapshot(targetId: string): Promise<McpManagementSnapshot> {
  return invoke("get_mcp_management_snapshot", { targetId });
}

/** Editable, redacted view of one saved definition. */
export function getMcpDefinition(
  targetId: string,
  entryId: string,
): Promise<McpEditableDefinition> {
  return invoke("get_mcp_definition", { targetId, entryId });
}

/** Field errors and an impact preview; writes nothing. */
export function validateMcpMutation(mutation: McpMutation): Promise<McpValidationResult> {
  return invoke("validate_mcp_mutation", { mutation });
}

/** Conflict-checked save; `save-and-apply` also schedules runtime application. */
export function mutateMcpDefinition(mutation: McpMutation): Promise<McpMutationResult> {
  return invoke("mutate_mcp_definition", { mutation });
}

/** Retry runtime application of an already saved change. Never re-saves. */
export function applyMcpConfiguration(operationId: string): Promise<McpOperationSnapshot> {
  return invoke("apply_mcp_configuration", { operationId });
}

export function getMcpOperation(operationId: string): Promise<McpOperationSnapshot> {
  return invoke("get_mcp_operation", { operationId });
}

/** Cancel queued application; the saved configuration is kept. */
export function cancelMcpApply(operationId: string): Promise<McpOperationSnapshot> {
  return invoke("cancel_mcp_apply", { operationId });
}
