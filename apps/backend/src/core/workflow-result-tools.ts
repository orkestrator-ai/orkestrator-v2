import type { McpServer } from "@modelcontextprotocol/server";
import type {
  WorkflowResultKind,
  WorkflowResultSubmission,
  WorkflowResultValidation,
} from "@orkestrator/protocol/workflow-results";
import {
  WORKFLOW_RESULT_KINDS,
  WORKFLOW_RESULT_VALIDATION_TOOL_NAME,
  workflowResultToolName,
} from "@orkestrator/protocol/workflow-results";
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

function resultResponse(result: WorkflowResultSubmission | WorkflowResultValidation) {
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

function capabilityDenied(): WorkflowResultSubmission {
  return {
    ok: false,
    error: {
      code: "capability_denied",
      nextAction: "stop",
      message: "This tool connection cannot access that workflow result key.",
    },
  };
}

/** Registers the tools exposed by one attempt-scoped result capability. */
export function registerWorkflowResultTools(
  server: McpServer,
  workflowResults: WorkflowResultService,
  scope: WorkflowResultToolScope,
): void {
  const submissionToolName = workflowResultToolName(scope.kind);
  const resultSchema = z.fromJSONSchema(workflowResultJsonSchema(scope.kind));
  server.registerTool(
    WORKFLOW_RESULT_VALIDATION_TOOL_NAME,
    {
      title: "Validate workflow result",
      description:
        "Validate one complete workflow result without accepting it, consuming a correction attempt, or changing workflow state. Use this instead of probing the submission tool.",
      inputSchema: z
        .object({
          resultKey: z.string().uuid(),
          result: resultSchema,
        })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ resultKey, result }) => {
      if (resultKey !== scope.workflowResultKey) return resultResponse(capabilityDenied());
      try {
        return resultResponse(await workflowResults.validate(scope, resultKey, result));
      } catch {
        return resultResponse(storageFailure());
      }
    },
  );
  server.registerTool(
    submissionToolName,
    {
      title: "Submit workflow result",
      description: `Submit the complete and final ${scope.kind.replaceAll("-", " ")} for this workflow attempt. Never use this tool for a probe, placeholder, partial draft, or transport test; use ${WORKFLOW_RESULT_VALIDATION_TOOL_NAME} instead. The first accepted payload is final and cannot be replaced. Only retry an accepted submission with the exact same payload.`,
      inputSchema: z
        .object({
          resultKey: z.string().uuid(),
          result: resultSchema,
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
      if (resultKey !== scope.workflowResultKey) return resultResponse(capabilityDenied());
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
      if (resultKey !== scope.workflowResultKey) return resultResponse(capabilityDenied());
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

/**
 * Registers the stable OpenCode broker surface.
 *
 * The bearer credential identifies only the environment/project. Every call
 * must additionally present the signed, one-attempt capability embedded in the
 * trusted workflow prompt, so directory-scoped MCP registration cannot widen
 * access to another attempt.
 */
export function registerWorkflowResultBrokerTools(
  server: McpServer,
  workflowResults: WorkflowResultService,
  scope: WorkflowResultCallerScope,
): void {
  for (const kind of WORKFLOW_RESULT_KINDS) {
    server.registerTool(
      workflowResultToolName(kind),
      {
        title: `Submit ${kind.replaceAll("-", " ")}`,
        description: `Submit the complete and final ${kind.replaceAll("-", " ")} for the authorized workflow attempt. Never use this tool for a probe, placeholder, partial draft, or transport test; use ${WORKFLOW_RESULT_VALIDATION_TOOL_NAME} instead. The first accepted payload is final and cannot be replaced. Only retry an accepted submission with the exact same payload.`,
        inputSchema: z
          .object({
            resultKey: z.string().uuid(),
            capability: z.string().min(32).max(2_048),
            result: z.fromJSONSchema(workflowResultJsonSchema(kind)),
          })
          .strict(),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ resultKey, capability, result }) => {
        try {
          if (
            !(await workflowResults.authorizeCapability(scope, resultKey, capability, "opencode"))
          ) {
            return resultResponse(capabilityDenied());
          }
          const binding = await workflowResults.binding(scope, resultKey);
          if (binding?.kind !== kind) return resultResponse(capabilityDenied());
          return resultResponse(await workflowResults.submit(scope, resultKey, result));
        } catch {
          return resultResponse(storageFailure());
        }
      },
    );
  }

  server.registerTool(
    WORKFLOW_RESULT_VALIDATION_TOOL_NAME,
    {
      title: "Validate workflow result",
      description:
        "Validate one complete authorized workflow result without accepting it, consuming a correction attempt, or changing workflow state. Use this instead of probing a submission tool.",
      inputSchema: z
        .object({
          resultKey: z.string().uuid(),
          capability: z.string().min(32).max(2_048),
          result: z.json(),
        })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ resultKey, capability, result }) => {
      try {
        if (
          !(await workflowResults.authorizeCapability(scope, resultKey, capability, "opencode"))
        ) {
          return resultResponse(capabilityDenied());
        }
        return resultResponse(await workflowResults.validate(scope, resultKey, result));
      } catch {
        return resultResponse(storageFailure());
      }
    },
  );

  server.registerTool(
    "get_workflow_result_status",
    {
      title: "Get workflow result status",
      description: "Check whether the authorized workflow result was accepted before retrying.",
      inputSchema: z
        .object({
          resultKey: z.string().uuid(),
          capability: z.string().min(32).max(2_048),
        })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ resultKey, capability }) => {
      try {
        if (
          !(await workflowResults.authorizeCapability(scope, resultKey, capability, "opencode"))
        ) {
          return resultResponse(capabilityDenied());
        }
        const status = await workflowResults.status(scope, resultKey);
        if (status) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify(status) }],
            structuredContent: status as unknown as Record<string, unknown>,
          };
        }
      } catch {
        return resultResponse(storageFailure());
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
