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

const validatedDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

function submissionDescription(label: string, authorized: boolean): string {
  return `Submit the complete and final ${label} for ${authorized ? "the authorized" : "this"} workflow attempt. Never use this tool for a probe, placeholder, partial draft, or transport test; use ${WORKFLOW_RESULT_VALIDATION_TOOL_NAME} instead. Pass exactly one of \`result\` (the complete payload) or \`validatedDigest\` (the digest ${WORKFLOW_RESULT_VALIDATION_TOOL_NAME} returned, which commits that exact validated payload without re-sending it). The first accepted payload is final and cannot be replaced. Only retry an accepted submission with the exact same payload.`;
}

/**
 * Commits either a full payload or a previously validated one. Exactly one must
 * be given: both would be ambiguous, and neither would be an empty probe.
 */
async function commitSubmission(
  workflowResults: WorkflowResultService,
  scope: WorkflowResultCallerScope,
  resultKey: string,
  result: unknown,
  validatedDigest: string | undefined,
): Promise<WorkflowResultSubmission> {
  if ((result === undefined) === (validatedDigest === undefined)) {
    return {
      ok: false,
      error: {
        code: "invalid_result",
        nextAction: "correct",
        message: "Provide exactly one of `result` or `validatedDigest`.",
        issues: [
          {
            path: "$",
            code: "invalid_arguments",
            message:
              "Pass the complete `result`, or the `validatedDigest` from validation, not both.",
          },
        ],
      },
    };
  }
  return validatedDigest !== undefined
    ? workflowResults.submitValidated(scope, resultKey, validatedDigest)
    : workflowResults.submit(scope, resultKey, result);
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
        "Validate one complete workflow result without accepting it, consuming a correction attempt, or changing workflow state. Use this instead of probing the submission tool. A valid result returns a validatedDigest that the submission tool can commit without re-sending the result.",
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
      description: submissionDescription(scope.kind.replaceAll("-", " "), false),
      inputSchema: z
        .object({
          resultKey: z.string().uuid(),
          result: resultSchema.optional(),
          validatedDigest: validatedDigestSchema.optional(),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ resultKey, result, validatedDigest }) => {
      if (resultKey !== scope.workflowResultKey) return resultResponse(capabilityDenied());
      try {
        return resultResponse(
          await commitSubmission(workflowResults, scope, resultKey, result, validatedDigest),
        );
      } catch {
        return resultResponse(storageFailure());
      }
    },
  );
  server.registerTool(
    "get_workflow_result_status",
    {
      title: "Get workflow result status",
      description:
        "Check whether this workflow result was accepted before retrying. For an open result it also reports which validation and submission calls actually reached the backend.",
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
        description: submissionDescription(kind.replaceAll("-", " "), true),
        inputSchema: z
          .object({
            resultKey: z.string().uuid(),
            capability: z.string().min(32).max(2_048),
            result: z.fromJSONSchema(workflowResultJsonSchema(kind)).optional(),
            validatedDigest: validatedDigestSchema.optional(),
          })
          .strict(),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ resultKey, capability, result, validatedDigest }) => {
        try {
          if (
            !(await workflowResults.authorizeCapability(scope, resultKey, capability, "opencode"))
          ) {
            return resultResponse(capabilityDenied());
          }
          const binding = await workflowResults.binding(scope, resultKey);
          if (binding?.kind !== kind) return resultResponse(capabilityDenied());
          return resultResponse(
            await commitSubmission(workflowResults, scope, resultKey, result, validatedDigest),
          );
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
        "Validate one complete authorized workflow result without accepting it, consuming a correction attempt, or changing workflow state. Use this instead of probing a submission tool. A valid result returns a validatedDigest that a submission tool can commit without re-sending the result.",
      inputSchema: z
        .object({
          resultKey: z.string().uuid(),
          capability: z.string().min(32).max(2_048),
          // Every result kind is an object; the service validates the contract.
          // z.json() would publish a recursive $ref that some providers reject.
          result: z.record(z.string(), z.unknown()),
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
