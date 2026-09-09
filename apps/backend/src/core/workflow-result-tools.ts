import type { McpServer } from "@modelcontextprotocol/server";
import type {
  WorkflowResultKind,
  WorkflowResultSubmission,
} from "@orkestrator/protocol/workflow-results";
import { workflowResultToolName } from "@orkestrator/protocol/workflow-results";
import { z } from "zod";
import { workflowResultJsonSchema } from "./workflow-result-contracts.js";
import type {
  WorkflowResultCallerScope,
  WorkflowResultService,
} from "./workflow-result-service.js";

export interface WorkflowResultToolScope extends WorkflowResultCallerScope {
  workflowResultKey: string;
  kind: WorkflowResultKind;
}

function resultResponse(result: WorkflowResultSubmission) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result as unknown as Record<string, unknown>,
    ...(!result.ok ? { isError: true as const } : {}),
  };
}

function storageFailure(): WorkflowResultSubmission {
  return {
    ok: false,
    error: {
      code: "storage_unavailable",
      nextAction: "lookup_or_resubmit",
      message:
        "The backend could not durably record or read the result. Check status before retrying.",
    },
  };
}

/** Registers the two tools exposed by one attempt-scoped result capability. */
export function registerWorkflowResultTools(
  server: McpServer,
  workflowResults: WorkflowResultService,
  scope: WorkflowResultToolScope,
): void {
  const denied = (): WorkflowResultSubmission => ({
    ok: false,
    error: {
      code: "capability_denied",
      nextAction: "stop",
      message: "This tool connection cannot access that workflow result key.",
    },
  });
  const submissionToolName = workflowResultToolName(scope.kind);
  server.registerTool(
    submissionToolName,
    {
      title: "Submit workflow result",
      description: `Submit the complete ${scope.kind.replaceAll("-", " ")} for this workflow attempt. Validation errors are returned for correction. Repeating an accepted result is safe.`,
      inputSchema: z
        .object({
          resultKey: z.string().uuid(),
          result: z.fromJSONSchema(workflowResultJsonSchema(scope.kind)),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ resultKey, result }) => {
      if (resultKey !== scope.workflowResultKey) return resultResponse(denied());
      try {
        return resultResponse(await workflowResults.submit(scope, resultKey, result));
      } catch {
        return resultResponse(storageFailure());
      }
    },
  );
  server.registerTool(
    "get_workflow_result_status",
    {
      title: "Get workflow result status",
      description: "Check whether this workflow result was accepted before retrying.",
      inputSchema: z.object({ resultKey: z.string().uuid() }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ resultKey }) => {
      if (resultKey !== scope.workflowResultKey) return resultResponse(denied());
      let status;
      try {
        status = await workflowResults.status(scope, resultKey);
      } catch {
        return resultResponse(storageFailure());
      }
      if (status) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(status) }],
          structuredContent: status as unknown as Record<string, unknown>,
        };
      }
      return resultResponse({
        ok: false,
        error: {
          code: "result_status_unavailable",
          nextAction: "stop",
          message: "The workflow result status is unavailable.",
        },
      });
    },
  );
}
