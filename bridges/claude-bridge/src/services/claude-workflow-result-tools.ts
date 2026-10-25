import {
  REPORT_FINDING_TOOL_NAME,
  WORKFLOW_RESULT_KINDS,
  WORKFLOW_RESULT_VALIDATION_TOOL_NAME,
  workflowResultToolName,
} from "@orkestrator/protocol/workflow-results";
import {
  ARTIFACT_TOOL_NAMES,
  ORKESTRATOR_ARTIFACT_MCP_SERVER_NAME,
} from "@orkestrator/protocol/transcript-artifacts";
import { AGENT_MCP_SERVER_NAME } from "./mcp-config.js";

/**
 * Only the injected Orkestrator server may report workflow results, and a
 * Multi Review reviewer's provisional findings with them. The backend lists
 * `report_finding` only on a live reviewer's own attempt.
 */
export function claudeWorkflowResultTools(servers: ReadonlySet<string>): string[] {
  if (!servers.has(AGENT_MCP_SERVER_NAME)) return [];
  return [
    ...WORKFLOW_RESULT_KINDS.map(workflowResultToolName),
    WORKFLOW_RESULT_VALIDATION_TOOL_NAME,
    "get_workflow_result_status",
    REPORT_FINDING_TOOL_NAME,
  ].map((name) => `mcp__${AGENT_MCP_SERVER_NAME}__${name}`);
}

/**
 * The artifact tools of a backend workflow turn's own `orkestrator-artifacts`
 * server. Like the result tools they run whatever the turn's approval mode
 * (they write only to Orkestrator's artifact store, never the workspace); an
 * explicit `toolPolicy.deny` still wins.
 */
export function claudeArtifactServerTools(servers: ReadonlySet<string>): string[] {
  if (!servers.has(ORKESTRATOR_ARTIFACT_MCP_SERVER_NAME)) return [];
  return ARTIFACT_TOOL_NAMES.map((name) => `mcp__${ORKESTRATOR_ARTIFACT_MCP_SERVER_NAME}__${name}`);
}
