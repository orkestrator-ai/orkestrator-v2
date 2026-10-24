import { fromJsonSchema, type JsonSchemaType, type McpServer } from "@modelcontextprotocol/server";
import { controlMcpConfirmationRule } from "@orkestrator/protocol/control-mcp";
import {
  PUBLIC_ACTION_NAMES,
  PUBLIC_ACTIONS,
  PUBLIC_API_LIMITS,
  type PublicActionName,
} from "@orkestrator/protocol/public-api";
import {
  PUBLIC_ACTION_INPUTS,
  type PublicActionInputSchema,
} from "@orkestrator/protocol/public-api-inputs";
import { allowed, runPublicAction, type ControlMcpCaller } from "./control-mcp-caller.js";
import { sayForEnvelope } from "./control-mcp-gateway.js";
import { envelopeToolResult } from "./control-mcp-results.js";

/**
 * Tier 2, `full` and `custom` profiles: one direct tool per allowed public
 * action, generated from the action's input schema in `packages/protocol`.
 * This suits coding agents whose clients defer or search tool definitions.
 * A direct tool is `run_action` with the action fixed: the same credential
 * check, request-key rule and confirmation, then one dispatch.
 *
 * Tool names replace the action's dots with underscores (`session.prompt` →
 * `session_prompt`) so they match `^[a-z0-9_]{1,64}$` on every client.
 */

export function directToolName(action: PublicActionName): string {
  return action.replace(/\./g, "_");
}

/** Every action a direct tool can exist for: all but `host`, which no MCP credential holds. */
export const DIRECT_TOOL_ACTIONS: readonly PublicActionName[] = PUBLIC_ACTION_NAMES.filter(
  (action) => PUBLIC_ACTION_INPUTS[action].capability !== "host",
);

const REQUEST_ID = {
  type: "string",
  minLength: 1,
  maxLength: PUBLIC_API_LIMITS.requestIdMaxChars,
  description: "Idempotency key: new for each request, reused only to retry the same one.",
} as const;
const CONFIRM_TOKEN = {
  type: "string",
  minLength: 1,
  maxLength: 200,
  description: "confirmToken from a confirmation-required result, after the user agreed.",
} as const;

/** The action's input schema plus the adapter's own fields. */
export function directToolSchema(
  action: PublicActionName,
  confirmable: boolean,
): PublicActionInputSchema {
  const base = PUBLIC_ACTION_INPUTS[action].input;
  const mutation = PUBLIC_ACTIONS[action].mutation;
  return {
    ...base,
    properties: {
      ...base.properties,
      ...(mutation ? { requestId: REQUEST_ID } : {}),
      ...(confirmable ? { confirmToken: CONFIRM_TOKEN } : {}),
    },
    required: mutation ? [...base.required, "requestId"] : base.required,
  };
}

const compiled = new Map<string, ReturnType<typeof fromJsonSchema>>();

/** Compiled once per process: the server is rebuilt for every request. */
function inputSchemaFor(action: PublicActionName, confirmable: boolean) {
  const key = `${action}:${confirmable}`;
  let schema = compiled.get(key);
  if (!schema) {
    schema = fromJsonSchema(directToolSchema(action, confirmable) as unknown as JsonSchemaType);
    compiled.set(key, schema);
  }
  return schema;
}

function description(caller: ControlMcpCaller, action: PublicActionName): string {
  const descriptor = PUBLIC_ACTIONS[action];
  const rule = controlMcpConfirmationRule(action, caller.profile);
  return [
    `${descriptor.summary} (public action ${action}).`,
    descriptor.mutation ? "Requires requestId." : "",
    descriptor.observation !== "immediate" ? "Follow the receipt with run_status." : "",
    rule !== "none"
      ? "Returns confirmation-required first; repeat with confirmToken once the user agrees."
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function registerDirectTools(server: McpServer, caller: ControlMcpCaller): void {
  for (const action of DIRECT_TOOL_ACTIONS) {
    if (!allowed(caller, action)) continue;
    const descriptor = PUBLIC_ACTIONS[action];
    const confirmable = controlMcpConfirmationRule(action, caller.profile) !== "none";
    server.registerTool(
      directToolName(action),
      {
        description: description(caller, action),
        inputSchema: inputSchemaFor(action, confirmable),
        annotations: {
          readOnlyHint: !descriptor.mutation,
          destructiveHint: descriptor.mutation,
          idempotentHint: true,
          openWorldHint: (descriptor.effects as readonly string[]).includes("external-repository"),
        },
      },
      async (args) => {
        const { confirmToken, ...input } = (args ?? {}) as Record<string, unknown>;
        const requestId = descriptor.mutation ? input.requestId : undefined;
        if (descriptor.mutation) delete input.requestId;
        const envelope = await runPublicAction(
          caller,
          action,
          input,
          typeof requestId === "string" ? requestId : undefined,
          confirmToken,
        );
        return envelopeToolResult(envelope, caller.profile, sayForEnvelope(envelope));
      },
    );
  }
}
