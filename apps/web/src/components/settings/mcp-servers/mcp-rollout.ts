import type { McpTargetCapabilities } from "@orkestrator/protocol/mcp-management";

/**
 * The backend's rollout gate, read from the capabilities it overlays. Absent
 * on older backends, which means both writing and applying are allowed. The
 * backend refuses gated requests itself (`management-disabled`); these only
 * keep the UI from offering what will be refused, and say why.
 */
export function writeBlockedReason(capabilities: McpTargetCapabilities): string | null {
  const gate = capabilities.rollout?.write;
  if (gate && !gate.supported)
    return gate.reason ?? "Changing MCP configuration is turned off on this backend.";
  if (!capabilities.management.supported)
    return capabilities.management.reason ?? "MCP configuration management is turned off.";
  return null;
}

export function applyBlockedReason(capabilities: McpTargetCapabilities): string | null {
  const gate = capabilities.rollout?.apply;
  if (gate && !gate.supported)
    return gate.reason ?? "Applying MCP changes to running sessions is turned off on this backend.";
  if (!capabilities.management.supported)
    return capabilities.management.reason ?? "MCP configuration management is turned off.";
  return null;
}
