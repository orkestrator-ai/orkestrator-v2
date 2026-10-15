import {
  WORKFLOW_RESULT_KINDS,
  WORKFLOW_RESULT_VALIDATION_TOOL_NAME,
  workflowResultToolName,
} from "@orkestrator/protocol/workflow-results";
import { AGENT_MCP_SERVER_NAME } from "./mcp-config.js";

/** Only the injected Orkestrator server may report workflow results. */
export function claudeWorkflowResultTools(servers: ReadonlySet<string>): string[] {
  if (!servers.has(AGENT_MCP_SERVER_NAME)) return [];
  return [
    ...WORKFLOW_RESULT_KINDS.map(workflowResultToolName),
    WORKFLOW_RESULT_VALIDATION_TOOL_NAME,
    "get_workflow_result_status",
  ].map((name) => `mcp__${AGENT_MCP_SERVER_NAME}__${name}`);
}
