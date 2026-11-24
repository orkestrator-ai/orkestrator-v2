import {
  workflowResultToolName,
  type WorkflowResultKind,
} from "@orkestrator/protocol/workflow-results";

/** Workspace publication is opt-in for writable pipeline result kinds. */
export const LINEAR_FILE_WRITE_RESULT_KINDS: readonly WorkflowResultKind[] = [
  "review-preparation",
  "validation-plan",
  "address-findings-result",
];

/** Attempt-scoped connection presented only to a writable OpenCode turn. */
export const LINEAR_FILE_WORKFLOW_MCP_PATH = "/linear-file-workflow-mcp";

export function isLinearFileWriteResultTool(tool: string | undefined): boolean {
  return LINEAR_FILE_WRITE_RESULT_KINDS.some((kind) => workflowResultToolName(kind) === tool);
}
